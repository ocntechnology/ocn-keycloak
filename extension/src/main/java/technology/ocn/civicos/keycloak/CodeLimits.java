package technology.ocn.civicos.keycloak;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Email-code limits per address, kept in a realm-level store (Keycloak's single-use object
 * store), not in the authentication session, so a new sign-in or a new code never resets them:
 *
 * <ul>
 *   <li>at most {@code per15Minutes} codes in 15 minutes and {@code perDay} codes in a day per address;</li>
 *   <li>wrong codes are counted per address, with or without an account, and
 *       {@code wrongBeforeLock} of them lock the address for {@code lockSeconds};</li>
 *   <li>a right code clears the wrong-code count; nothing else does.</li>
 * </ul>
 *
 * Keys are a SHA-256 of the realm and the address, so the store never holds the address itself.
 * Read-modify-write is not atomic: two requests at the same instant may both get through, which
 * at worst allows one extra code or guess.
 */
public final class CodeLimits {
    public static final long WINDOW_SHORT = 15 * 60;
    public static final long WINDOW_DAY = 24 * 3600;

    public record Config(int per15Minutes, int perDay, int wrongBeforeLock, long lockSeconds) {
        public static final Config DEFAULT = new Config(3, 10, 10, 15 * 60);
    }

    /** Where the counters live (Keycloak's single-use object store; a map in tests). */
    public interface Store {
        Map<String, String> get(String key);
        void put(String key, long lifespanSeconds, Map<String, String> value);
        void remove(String key);
    }

    public enum Send { OK, CAPPED, LOCKED }

    private CodeLimits() {}

    static String key(String realmId, String kind, String email) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update((realmId + "|" + email.trim().toLowerCase(Locale.ROOT)).getBytes(StandardCharsets.UTF_8));
            return "civicos.codes." + kind + "." + HexFormat.of().formatHex(md.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Is the address locked after too many wrong codes? */
    public static boolean locked(Store store, String realmId, String email, long now) {
        Map<String, String> m = store.get(key(realmId, "lock", email));
        if (m == null) return false;
        String until = m.get("until");
        return until == null || Long.parseLong(until) > now;
    }

    /** May a code be sent to this address now? If so, the send is counted. */
    public static Send trySend(Store store, Config c, String realmId, String email, long now) {
        if (locked(store, realmId, email, now)) return Send.LOCKED;
        String k = key(realmId, "sent", email);
        List<Long> sent = new ArrayList<>();
        Map<String, String> m = store.get(k);
        if (m != null && m.get("t") != null && !m.get("t").isBlank()) {
            for (String s : m.get("t").split(",")) {
                long t = Long.parseLong(s);
                if (now - t < WINDOW_DAY) sent.add(t);
            }
        }
        long recent = sent.stream().filter(t -> now - t < WINDOW_SHORT).count();
        if (recent >= c.per15Minutes() || sent.size() >= c.perDay()) return Send.CAPPED;
        sent.add(now);
        StringBuilder sb = new StringBuilder();
        for (Long t : sent) { if (sb.length() > 0) sb.append(','); sb.append(t); }
        store.put(k, WINDOW_DAY, Map.of("t", sb.toString()));
        return Send.OK;
    }

    /** Count a wrong code for the address. Returns true if the address is now locked. */
    public static boolean wrong(Store store, Config c, String realmId, String email, long now) {
        String k = key(realmId, "wrong", email);
        Map<String, String> m = store.get(k);
        int n = (m == null || m.get("n") == null ? 0 : Integer.parseInt(m.get("n"))) + 1;
        if (n >= c.wrongBeforeLock()) {
            store.put(key(realmId, "lock", email), c.lockSeconds(), Map.of("until", Long.toString(now + c.lockSeconds())));
            store.remove(k);
            return true;
        }
        store.put(k, WINDOW_DAY, Map.of("n", Integer.toString(n)));
        return false;
    }

    /** A right code: the wrong-code count starts again. */
    public static void succeeded(Store store, String realmId, String email) {
        store.remove(key(realmId, "wrong", email));
    }

    /** Support: lift every limit for an address. */
    public static void reset(Store store, String realmId, String email) {
        for (String kind : new String[] {"sent", "wrong", "lock"}) store.remove(key(realmId, kind, email));
    }

    /** The store backed by Keycloak's single-use object provider (shared across the cluster). */
    public static Store keycloak(org.keycloak.models.KeycloakSession session) {
        org.keycloak.models.SingleUseObjectProvider p = session.singleUseObjects();
        return new Store() {
            public Map<String, String> get(String key) { return p.get(key); }
            public void put(String key, long lifespanSeconds, Map<String, String> value) { p.put(key, lifespanSeconds, value); }
            public void remove(String key) { if (p.contains(key)) p.remove(key); }
        };
    }
}
