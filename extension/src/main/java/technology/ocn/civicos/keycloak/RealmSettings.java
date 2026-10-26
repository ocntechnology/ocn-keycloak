package technology.ocn.civicos.keycloak;

import org.keycloak.models.RealmModel;

/**
 * CivicOS limits that live in realm attributes (managed in realm/config/settings.json), so they
 * can be changed without a new build and shortened by the integration tests. Missing or
 * unreadable values fall back to the platform defaults below.
 */
public final class RealmSettings {
    /** Council SSO sessions go back through the council's sign-in after this long. */
    public static final String SSO_SESSION_MAX = "civicos.ssoSessionMaxSeconds";
    public static final long DEFAULT_SSO_SESSION_MAX = 12 * 3600;
    /** Password and code sign-ins re-prove the mailbox after this long. */
    public static final String MAILBOX_MAX_AGE = "civicos.mailboxMaxAgeSeconds";
    public static final long DEFAULT_MAILBOX_MAX_AGE = 30L * 24 * 3600;
    /** Email codes per address. */
    public static final String CODES_PER_15_MINUTES = "civicos.codes.per15Minutes";
    public static final String CODES_PER_DAY = "civicos.codes.perDay";
    public static final String WRONG_CODES_BEFORE_LOCK = "civicos.codes.wrongBeforeLock";
    public static final String CODE_LOCK_SECONDS = "civicos.codes.lockSeconds";
    /** Erasure notices: first retry after this many seconds, then four times longer each time. */
    public static final String ERASURE_RETRY_BASE = "civicos.erasure.retryBaseSeconds";
    public static final long DEFAULT_ERASURE_RETRY_BASE = 60;

    private RealmSettings() {}

    public static long seconds(RealmModel realm, String key, long dflt) {
        String v = realm == null ? null : realm.getAttribute(key);
        if (v == null || v.isBlank()) return dflt;
        try {
            long n = Long.parseLong(v.trim());
            return n > 0 ? n : dflt;
        } catch (NumberFormatException e) {
            return dflt;
        }
    }

    public static long ssoSessionMaxSeconds(RealmModel realm) { return seconds(realm, SSO_SESSION_MAX, DEFAULT_SSO_SESSION_MAX); }

    public static long mailboxMaxAgeSeconds(RealmModel realm) { return seconds(realm, MAILBOX_MAX_AGE, DEFAULT_MAILBOX_MAX_AGE); }

    public static CodeLimits.Config codeLimits(RealmModel realm) {
        CodeLimits.Config d = CodeLimits.Config.DEFAULT;
        return new CodeLimits.Config(
            (int) seconds(realm, CODES_PER_15_MINUTES, d.per15Minutes()),
            (int) seconds(realm, CODES_PER_DAY, d.perDay()),
            (int) seconds(realm, WRONG_CODES_BEFORE_LOCK, d.wrongBeforeLock()),
            seconds(realm, CODE_LOCK_SECONDS, d.lockSeconds()));
    }

    public static long erasureRetryBaseSeconds(RealmModel realm) { return seconds(realm, ERASURE_RETRY_BASE, DEFAULT_ERASURE_RETRY_BASE); }
}
