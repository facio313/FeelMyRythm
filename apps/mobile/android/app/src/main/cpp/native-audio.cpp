#include <jni.h>
#include <oboe/AudioStream.h>
#include <oboe/AudioStreamBuilder.h>
#include <oboe/AudioStreamCallback.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <time.h>
#include <vector>

namespace {

struct ClickEvent {
    double atTimeSec;
    int kind;
};

double monotonicSeconds() {
    timespec value{};
    clock_gettime(CLOCK_MONOTONIC, &value);
    return static_cast<double>(value.tv_sec) + static_cast<double>(value.tv_nsec) / 1'000'000'000.0;
}

double durationFor(int kind) {
    switch (kind) {
        case 0: return 0.055;
        case 1: return 0.045;
        case 2: return 0.028;
        default: return 0.060;
    }
}

float clickSample(int kind, double time) {
    constexpr double pi = 3.14159265358979323846;
    double frequency;
    double overtoneRatio;
    double gain;
    double decay;
    switch (kind) {
        case 0:
            frequency = 1760.0; overtoneRatio = 2.1; gain = 0.95; decay = 78.0; break;
        case 1:
            frequency = 1180.0; overtoneRatio = 2.4; gain = 0.72; decay = 78.0; break;
        case 2:
            frequency = 760.0; overtoneRatio = 1.7; gain = 0.46; decay = 115.0; break;
        default:
            frequency = 2240.0; overtoneRatio = 1.45; gain = 0.82; decay = 78.0; break;
    }
    const double attack = std::min(1.0, time / 0.0008);
    const double envelope = attack * std::exp(-time * decay);
    const double primary = std::sin(2.0 * pi * frequency * time);
    const double overtone = std::sin(2.0 * pi * frequency * overtoneRatio * time + 0.35);
    const double noiseSeed = std::sin((std::floor(time * 48'000.0) + 1.0) * 12.9898) * 43'758.5453;
    const double noise = ((noiseSeed - std::floor(noiseSeed)) * 2.0 - 1.0) * std::exp(-time * 260.0);
    return static_cast<float>(gain * envelope * (0.68 * primary + 0.24 * overtone + 0.08 * noise));
}

class NativeEngine final : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback {
public:
    std::pair<double, double> start(float volume) {
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        volume_.store(volume, std::memory_order_release);
        if (stream_ && stream_->getState() != oboe::StreamState::Closed) {
            return {monotonicSeconds(), outputLatencySec_.load(std::memory_order_acquire)};
        }
        stream_.reset();

        oboe::AudioStreamBuilder builder;
        builder.setDirection(oboe::Direction::Output);
        builder.setPerformanceMode(oboe::PerformanceMode::LowLatency);
        builder.setSharingMode(oboe::SharingMode::Exclusive);
        builder.setFormat(oboe::AudioFormat::Float);
        builder.setChannelCount(oboe::ChannelCount::Stereo);
        builder.setUsage(oboe::Usage::Media);
        builder.setContentType(oboe::ContentType::Music);
        builder.setDataCallback(
            std::shared_ptr<oboe::AudioStreamDataCallback>(this, [](oboe::AudioStreamDataCallback*) {})
        );
        builder.setErrorCallback(
            std::shared_ptr<oboe::AudioStreamErrorCallback>(this, [](oboe::AudioStreamErrorCallback*) {})
        );

        auto result = builder.openStream(stream_);
        if (result != oboe::Result::OK) {
            builder.setSharingMode(oboe::SharingMode::Shared);
            result = builder.openStream(stream_);
        }
        if (result != oboe::Result::OK || !stream_) {
            stream_.reset();
            throw std::runtime_error("Oboe output stream could not be opened");
        }

        sampleRate_ = stream_->getSampleRate();
        const int32_t burst = std::max(1, stream_->getFramesPerBurst());
        stream_->setBufferSizeInFrames(burst * 2);
        outputLatencySec_.store(
            static_cast<double>(burst * 2) / static_cast<double>(sampleRate_) + 0.006,
            std::memory_order_release
        );
        framesRendered_.store(0, std::memory_order_release);
        fallbackPresentationStart_.store(0, std::memory_order_release);
        result = stream_->requestStart();
        if (result != oboe::Result::OK) {
            stream_->close();
            stream_.reset();
            throw std::runtime_error("Oboe output stream could not start");
        }
        return {monotonicSeconds(), outputLatencySec_.load(std::memory_order_acquire)};
    }

    double schedule(const std::vector<ClickEvent>& incoming) {
        std::lock_guard<std::mutex> lock(eventsMutex_);
        auto current = std::atomic_load_explicit(&events_, std::memory_order_acquire);
        auto next = std::make_shared<std::vector<ClickEvent>>(current ? *current : std::vector<ClickEvent>{});
        next->insert(next->end(), incoming.begin(), incoming.end());
        std::stable_sort(next->begin(), next->end(), [](const ClickEvent& left, const ClickEvent& right) {
            return left.atTimeSec < right.atTimeSec;
        });
        const double end = lastTime(*next);
        std::atomic_store_explicit(
            &events_,
            std::static_pointer_cast<const std::vector<ClickEvent>>(next),
            std::memory_order_release
        );
        return end;
    }

    double cancelFrom(double cutoff) {
        std::lock_guard<std::mutex> lock(eventsMutex_);
        auto current = std::atomic_load_explicit(&events_, std::memory_order_acquire);
        auto next = std::make_shared<std::vector<ClickEvent>>();
        if (current) {
            next->reserve(current->size());
            std::copy_if(current->begin(), current->end(), std::back_inserter(*next), [cutoff](const ClickEvent& event) {
                return event.atTimeSec + 0.000'001 < cutoff;
            });
        }
        const double end = lastTime(*next);
        std::atomic_store_explicit(
            &events_,
            std::static_pointer_cast<const std::vector<ClickEvent>>(next),
            std::memory_order_release
        );
        return end;
    }

    void setVolume(float volume) { volume_.store(volume, std::memory_order_release); }

    void stop() {
        std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
        {
            std::lock_guard<std::mutex> eventsLock(eventsMutex_);
            std::atomic_store_explicit(
                &events_,
                std::make_shared<const std::vector<ClickEvent>>(),
                std::memory_order_release
            );
        }
        if (stream_) {
            stream_->requestStop();
            stream_->close();
            stream_.reset();
        }
    }

    oboe::DataCallbackResult onAudioReady(
        oboe::AudioStream* stream,
        void* audioData,
        int32_t numFrames
    ) override {
        auto* output = static_cast<float*>(audioData);
        const int32_t channels = std::max(1, stream->getChannelCount());
        std::fill(output, output + numFrames * channels, 0.0F);

        const int64_t firstFrame = framesRendered_.fetch_add(numFrames, std::memory_order_acq_rel);
        double streamClockStart = fallbackPresentationStart_.load(std::memory_order_acquire);
        if (streamClockStart == 0) {
            // AudioEngine times represent graph/render times. ServerAudioMapper subtracts the
            // separately reported output latency when audible wall-clock alignment is required.
            streamClockStart = monotonicSeconds();
            fallbackPresentationStart_.store(streamClockStart, std::memory_order_release);
        }
        const double presentationStart = streamClockStart
            + static_cast<double>(firstFrame) / static_cast<double>(sampleRate_);
        const double presentationEnd = presentationStart
            + static_cast<double>(numFrames) / static_cast<double>(sampleRate_);
        auto snapshot = std::atomic_load_explicit(&events_, std::memory_order_acquire);
        if (!snapshot || snapshot->empty()) return oboe::DataCallbackResult::Continue;

        const auto first = std::lower_bound(
            snapshot->begin(),
            snapshot->end(),
            presentationStart - 0.061,
            [](const ClickEvent& event, double time) { return event.atTimeSec < time; }
        );
        const float volume = volume_.load(std::memory_order_acquire);
        for (auto event = first; event != snapshot->end() && event->atTimeSec < presentationEnd; ++event) {
            const double duration = durationFor(event->kind);
            for (int32_t frame = 0; frame < numFrames; ++frame) {
                const double eventTime = presentationStart
                    + static_cast<double>(frame) / static_cast<double>(sampleRate_)
                    - event->atTimeSec;
                if (eventTime < 0 || eventTime >= duration) continue;
                const float sample = volume * clickSample(event->kind, eventTime);
                for (int32_t channel = 0; channel < channels; ++channel) {
                    output[frame * channels + channel] += sample;
                }
            }
        }
        return oboe::DataCallbackResult::Continue;
    }

    void onErrorAfterClose(oboe::AudioStream*, oboe::Result) override {}

private:
    static double lastTime(const std::vector<ClickEvent>& events) {
        return events.empty() ? std::numeric_limits<double>::quiet_NaN() : events.back().atTimeSec;
    }

    std::mutex lifecycleMutex_;
    std::mutex eventsMutex_;
    std::shared_ptr<oboe::AudioStream> stream_;
    std::shared_ptr<const std::vector<ClickEvent>> events_ =
        std::make_shared<const std::vector<ClickEvent>>();
    std::atomic<float> volume_{0.8F};
    std::atomic<double> outputLatencySec_{0.02};
    std::atomic<int64_t> framesRendered_{0};
    std::atomic<double> fallbackPresentationStart_{0};
    int32_t sampleRate_ = 48'000;
};

NativeEngine engine;

void throwJava(JNIEnv* env, const char* message) {
    jclass exception = env->FindClass("java/lang/IllegalStateException");
    env->ThrowNew(exception, message);
}

}  // namespace

extern "C" JNIEXPORT jdoubleArray JNICALL
Java_work_bonifacio_feelmyrythm_NativeAudioPlugin_nativeStart(JNIEnv* env, jclass, jfloat volume) {
    try {
        const auto result = engine.start(volume);
        jdouble values[2] = {result.first, result.second};
        jdoubleArray output = env->NewDoubleArray(2);
        env->SetDoubleArrayRegion(output, 0, 2, values);
        return output;
    } catch (const std::exception& error) {
        throwJava(env, error.what());
        return nullptr;
    }
}

extern "C" JNIEXPORT jdouble JNICALL
Java_work_bonifacio_feelmyrythm_NativeAudioPlugin_nativeSchedule(
    JNIEnv* env,
    jclass,
    jdoubleArray times,
    jintArray kinds
) {
    const jsize count = env->GetArrayLength(times);
    if (env->GetArrayLength(kinds) != count) {
        throwJava(env, "Native click arrays have different lengths");
        return 0;
    }
    std::vector<jdouble> timeValues(static_cast<size_t>(count));
    std::vector<jint> kindValues(static_cast<size_t>(count));
    env->GetDoubleArrayRegion(times, 0, count, timeValues.data());
    env->GetIntArrayRegion(kinds, 0, count, kindValues.data());
    std::vector<ClickEvent> incoming;
    incoming.reserve(static_cast<size_t>(count));
    for (jsize index = 0; index < count; ++index) {
        incoming.push_back({timeValues[index], kindValues[index]});
    }
    return engine.schedule(incoming);
}

extern "C" JNIEXPORT jdouble JNICALL
Java_work_bonifacio_feelmyrythm_NativeAudioPlugin_nativeCancelFrom(
    JNIEnv*,
    jclass,
    jdouble cutoff
) {
    return engine.cancelFrom(cutoff);
}

extern "C" JNIEXPORT void JNICALL
Java_work_bonifacio_feelmyrythm_NativeAudioPlugin_nativeSetVolume(
    JNIEnv*,
    jclass,
    jfloat volume
) {
    engine.setVolume(volume);
}

extern "C" JNIEXPORT void JNICALL
Java_work_bonifacio_feelmyrythm_NativeAudioPlugin_nativeStop(JNIEnv*, jclass) {
    engine.stop();
}
