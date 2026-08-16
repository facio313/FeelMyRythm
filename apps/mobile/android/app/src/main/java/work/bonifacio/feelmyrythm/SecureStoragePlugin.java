package work.bonifacio.feelmyrythm;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "work.bonifacio.feelmyrythm.secure-storage";
    private static final String PREFERENCES = "fmr_secure_storage";

    @PluginMethod
    public void get(PluginCall call) {
        String key = required(call, "key");
        if (key == null) return;

        String encoded = preferences().getString(key, null);
        JSObject result = new JSObject();
        if (encoded == null) {
            result.put("value", JSONObject.NULL);
            call.resolve(result);
            return;
        }

        try {
            String[] parts = encoded.split("\\.", 2);
            if (parts.length != 2) throw new IllegalStateException("invalid encrypted value");
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            String value = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
            result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            preferences().edit().remove(key).apply();
            call.reject("Secure value could not be decrypted", error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = required(call, "key");
        String value = required(call, "value");
        if (key == null || value == null) return;

        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String ciphertext = Base64.encodeToString(
                cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),
                Base64.NO_WRAP
            );
            if (!preferences().edit().putString(key, iv + "." + ciphertext).commit()) {
                throw new IllegalStateException("secure preferences commit failed");
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("Secure value could not be stored", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = required(call, "key");
        if (key == null) return;
        if (preferences().edit().remove(key).commit()) {
            call.resolve();
        } else {
            call.reject("Secure value could not be removed");
        }
    }

    private String required(PluginCall call, String name) {
        String value = call.getString(name);
        if (value == null || value.isEmpty()) {
            call.reject(name + " is required");
            return null;
        }
        return value;
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private synchronized SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE);
            generator.init(
                new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            );
            generator.generateKey();
        }
        return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
    }
}
