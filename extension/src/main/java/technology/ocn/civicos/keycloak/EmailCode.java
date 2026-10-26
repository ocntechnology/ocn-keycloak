package technology.ocn.civicos.keycloak;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HexFormat;

/**
 * Email sign-in codes: six digits, valid 10 minutes, 5 attempts. The code itself is never
 * stored, only a salted SHA-256 of it, in authentication-session notes.
 */
public final class EmailCode {
    public static final int DIGITS = 6;
    public static final long TTL_SECONDS = 10 * 60;
    public static final int MAX_ATTEMPTS = 5;
    public static final long RESEND_AFTER_SECONDS = 30;

    public static final String N_HASH = "civicos.code.hash";
    public static final String N_SALT = "civicos.code.salt";
    public static final String N_EXPIRES = "civicos.code.expires";
    public static final String N_ATTEMPTS = "civicos.code.attempts";
    public static final String N_SENT = "civicos.code.sent";

    /** Where the notes live (the authentication session in Keycloak; a map in tests). */
    public interface Notes {
        String get(String key);
        void set(String key, String value);
        void remove(String key);
    }

    public enum Result { OK, WRONG, EXPIRED, TOO_MANY_ATTEMPTS, NO_CODE }

    private static final SecureRandom RANDOM = new SecureRandom();

    private EmailCode() {}

    /** Issue a fresh code, replacing any earlier one. Returns the code to send. */
    public static String issue(Notes notes, long nowSeconds) {
        int n = RANDOM.nextInt(1_000_000);
        String code = String.format("%06d", n);
        byte[] saltBytes = new byte[16];
        RANDOM.nextBytes(saltBytes);
        String salt = HexFormat.of().formatHex(saltBytes);
        notes.set(N_SALT, salt);
        notes.set(N_HASH, hash(salt, code));
        notes.set(N_EXPIRES, Long.toString(nowSeconds + TTL_SECONDS));
        notes.set(N_ATTEMPTS, "0");
        notes.set(N_SENT, Long.toString(nowSeconds));
        return code;
    }

    public static boolean canResend(Notes notes, long nowSeconds) {
        String sent = notes.get(N_SENT);
        return sent == null || nowSeconds - Long.parseLong(sent) >= RESEND_AFTER_SECONDS;
    }

    public static boolean hasCode(Notes notes) { return notes.get(N_HASH) != null; }

    public static Result verify(Notes notes, String submitted, long nowSeconds) {
        String h = notes.get(N_HASH);
        if (h == null) return Result.NO_CODE;
        if (nowSeconds > Long.parseLong(notes.get(N_EXPIRES))) {
            clear(notes);
            return Result.EXPIRED;
        }
        int attempts = Integer.parseInt(notes.get(N_ATTEMPTS)) + 1;
        String clean = submitted == null ? "" : submitted.replaceAll("[\\s-]", "");
        if (clean.length() == DIGITS && MessageDigest.isEqual(h.getBytes(StandardCharsets.US_ASCII), hash(notes.get(N_SALT), clean).getBytes(StandardCharsets.US_ASCII))) {
            clear(notes);
            return Result.OK;
        }
        if (attempts >= MAX_ATTEMPTS) {
            clear(notes);
            return Result.TOO_MANY_ATTEMPTS;
        }
        notes.set(N_ATTEMPTS, Integer.toString(attempts));
        return Result.WRONG;
    }

    public static int attemptsLeft(Notes notes) {
        String a = notes.get(N_ATTEMPTS);
        return a == null ? MAX_ATTEMPTS : MAX_ATTEMPTS - Integer.parseInt(a);
    }

    public static void clear(Notes notes) {
        for (String k : new String[] {N_HASH, N_SALT, N_EXPIRES, N_ATTEMPTS}) notes.remove(k);
    }

    static String hash(String salt, String code) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(salt.getBytes(StandardCharsets.US_ASCII));
            md.update(code.getBytes(StandardCharsets.US_ASCII));
            return HexFormat.of().formatHex(md.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
