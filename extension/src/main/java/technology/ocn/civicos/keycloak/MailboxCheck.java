package technology.ocn.civicos.keycloak;

import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;

/**
 * 30-day mailbox re-verification for sign-ins without SSO: a person who signs in with a
 * password must prove they still have their mailbox with an email code every 30 days, so a
 * leaver whose mailbox is closed is locked out. The time is the user attribute
 * {@code civicosMailboxVerifiedAt} (ISO-8601, admin-only in the user profile).
 */
public final class MailboxCheck {
    public static final String ATTRIBUTE = "civicosMailboxVerifiedAt";
    public static final Duration MAX_AGE = Duration.ofDays(30);

    private MailboxCheck() {}

    public static boolean due(String lastVerified, Instant now) {
        return due(lastVerified, now, MAX_AGE.getSeconds());
    }

    /** As above with the realm's limit ({@link RealmSettings#mailboxMaxAgeSeconds}). */
    public static boolean due(String lastVerified, Instant now, long maxAgeSeconds) {
        if (lastVerified == null || lastVerified.isBlank()) return true;
        try {
            Instant t = Instant.parse(lastVerified.trim());
            return Duration.between(t, now).getSeconds() > maxAgeSeconds;
        } catch (DateTimeParseException e) {
            return true;
        }
    }
}
