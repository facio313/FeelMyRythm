package work.bonifacio.feelmyrythm;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;

@CapacitorPlugin(name = "NativeAudio")
public class NativeAudioPlugin extends Plugin {
    private static final Map<String, Integer> CLICK_KINDS = new HashMap<>();
    private static volatile float requestedVolume = 0.8F;
    private static volatile boolean focusMuted = false;
    private static WeakReference<NativeAudioPlugin> activePlugin = new WeakReference<>(null);

    static {
        CLICK_KINDS.put("downbeat", 0);
        CLICK_KINDS.put("beat", 1);
        CLICK_KINDS.put("sub", 2);
        CLICK_KINDS.put("countIn", 3);
        System.loadLibrary("native-audio");
    }

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Double volume = boundedVolume(call);
        if (volume == null) return;
        try {
            requestedVolume = volume.floatValue();
            double[] state = nativeStart(focusMuted ? 0 : requestedVolume);
            NativeAudioPlaybackService.start(getContext());
            JSObject result = new JSObject();
            result.put("nativeTimeSec", state[0]);
            result.put("outputLatencySec", state[1]);
            call.resolve(result);
        } catch (Exception error) {
            nativeStop();
            call.reject("Native audio could not start", error);
        }
    }

    @PluginMethod
    public void scheduleClicks(PluginCall call) {
        JSArray rawClicks = call.getArray("clicks");
        if (rawClicks == null) {
            call.reject("clicks is required");
            return;
        }
        double[] times = new double[rawClicks.length()];
        int[] kinds = new int[rawClicks.length()];
        try {
            for (int index = 0; index < rawClicks.length(); index += 1) {
                JSObject raw = JSObject.fromJSONObject(rawClicks.getJSONObject(index));
                double atTimeSec = raw.getDouble("atTimeSec");
                String kind = raw.getString("kind");
                Integer encodedKind = CLICK_KINDS.get(kind);
                if (!Double.isFinite(atTimeSec) || encodedKind == null) {
                    call.reject("Every click requires a finite atTimeSec and valid kind");
                    return;
                }
                times[index] = atTimeSec;
                kinds[index] = encodedKind;
            }
            double lastTimeSec = nativeSchedule(times, kinds);
            NativeAudioPlaybackService.updateNaturalEnd(getContext(), lastTimeSec);
            call.resolve();
        } catch (JSONException error) {
            call.reject("Clicks could not be decoded", error);
        }
    }

    @PluginMethod
    public void cancelScheduledFrom(PluginCall call) {
        Double atTimeSec = call.getDouble("atTimeSec");
        if (atTimeSec == null || !Double.isFinite(atTimeSec)) {
            call.reject("atTimeSec must be finite");
            return;
        }
        double lastTimeSec = nativeCancelFrom(atTimeSec);
        NativeAudioPlaybackService.updateNaturalEnd(getContext(), lastTimeSec);
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = boundedVolume(call);
        if (volume == null) return;
        requestedVolume = volume.floatValue();
        nativeSetVolume(focusMuted ? 0 : requestedVolume);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopEngineAndService(getContext());
        call.resolve();
    }

    static void setFocusMuted(boolean muted) {
        focusMuted = muted;
        nativeSetVolume(muted ? 0 : requestedVolume);
    }

    static void stopFromService(String reason) {
        nativeStop();
        NativeAudioPlugin plugin = activePlugin.get();
        if (plugin != null) {
            JSObject event = new JSObject();
            event.put("reason", reason);
            plugin.notifyListeners("stopped", event, true);
        }
    }

    private static void stopEngineAndService(android.content.Context context) {
        nativeStop();
        NativeAudioPlaybackService.stop(context);
    }

    private Double boundedVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        if (volume == null || !Double.isFinite(volume) || volume < 0 || volume > 1) {
            call.reject("volume must be between 0 and 1");
            return null;
        }
        return volume;
    }

    private static native double[] nativeStart(float volume);
    private static native double nativeSchedule(double[] times, int[] kinds);
    private static native double nativeCancelFrom(double cutoff);
    private static native void nativeSetVolume(float volume);
    private static native void nativeStop();
}
