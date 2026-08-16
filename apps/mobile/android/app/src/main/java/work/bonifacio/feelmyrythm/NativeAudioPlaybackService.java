package work.bonifacio.feelmyrythm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.session.MediaSession;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.content.ContextCompat;

public class NativeAudioPlaybackService extends Service {
    private static final String CHANNEL_ID = "metronome_playback";
    private static final int NOTIFICATION_ID = 3107;
    private static final String ACTION_START = "work.bonifacio.feelmyrythm.audio.START";
    private static final String ACTION_STOP = "work.bonifacio.feelmyrythm.audio.STOP";
    private static final String ACTION_UPDATE_END = "work.bonifacio.feelmyrythm.audio.UPDATE_END";
    private static final String EXTRA_END_TIME = "endTimeSec";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable naturalStop = () -> stopPlayback("naturalEnd");
    private MediaSession mediaSession;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;

    static void start(Context context) {
        Intent intent = new Intent(context, NativeAudioPlaybackService.class).setAction(ACTION_START);
        ContextCompat.startForegroundService(context, intent);
    }

    static void updateNaturalEnd(Context context, double endTimeSec) {
        Intent intent = new Intent(context, NativeAudioPlaybackService.class)
            .setAction(ACTION_UPDATE_END)
            .putExtra(EXTRA_END_TIME, endTimeSec);
        context.startService(intent);
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, NativeAudioPlaybackService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        mediaSession = new MediaSession(this, "FeelMyRythmMetronome");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onStop() {
                stopPlayback("mediaControl");
            }
        });
        mediaSession.setActive(true);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(this::onAudioFocusChange, handler)
                .build();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_STOP : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopPlayback("mediaControl");
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, buildNotification());
        if (ACTION_START.equals(action)) requestAudioFocus();
        if (ACTION_UPDATE_END.equals(action)) {
            scheduleNaturalStop(intent.getDoubleExtra(EXTRA_END_TIME, Double.NaN));
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(naturalStop);
        abandonAudioFocus();
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        super.onDestroy();
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) launchIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        PendingIntent stopIntent = PendingIntent.getService(
            this,
            1,
            new Intent(this, NativeAudioPlaybackService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("FeelMyRythm")
            .setContentText("메트로놈 재생 중")
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .addAction(new Notification.Action.Builder(
                Icon.createWithResource(this, android.R.drawable.ic_media_pause),
                "정지",
                stopIntent
            ).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(mediaSession.getSessionToken()))
            .build();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "메트로놈 재생",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("백그라운드 메트로놈 재생 상태");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void scheduleNaturalStop(double endTimeSec) {
        handler.removeCallbacks(naturalStop);
        if (!Double.isFinite(endTimeSec)) return;
        double remainingSec = endTimeSec - System.nanoTime() / 1_000_000_000.0 + 0.35;
        handler.postDelayed(naturalStop, Math.max(0, (long) Math.ceil(remainingSec * 1_000)));
    }

    private void requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(
                this::onAudioFocusChange,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            );
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
        }
    }

    private void onAudioFocusChange(int change) {
        if (change == AudioManager.AUDIOFOCUS_GAIN) {
            NativeAudioPlugin.setFocusMuted(false);
        } else if (
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
        ) {
            NativeAudioPlugin.setFocusMuted(true);
        } else if (change == AudioManager.AUDIOFOCUS_LOSS) {
            stopPlayback("audioFocusLoss");
        }
    }

    private void stopPlayback(String reason) {
        handler.removeCallbacks(naturalStop);
        NativeAudioPlugin.stopFromService(reason);
        abandonAudioFocus();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
}
