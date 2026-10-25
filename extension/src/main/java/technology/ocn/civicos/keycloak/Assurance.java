package technology.ocn.civicos.keycloak;

/** Assurance levels, sent as the {@code acr} claim ("1" or "2"; realm acr.loa.map {"1":1,"2":2}). */
public final class Assurance {
    public static final int VERIFIED_EMAIL = 1;
    public static final int STRONG = 2;
    /** Council SSO sessions go back through the council's sign-in after this long. */
    public static final long SSO_SESSION_SECONDS = 12 * 3600;

    private Assurance() {}

    public static int level(String method, boolean secondFactor) {
        if ("sso".equals(method) || secondFactor) return STRONG;
        return VERIFIED_EMAIL;
    }

    /** Realm role held by OCN staff. Staff always use a second step (an authenticator app). */
    public static final String STAFF_ROLE = "ocn-staff";

    /** Is a second step needed after a password or email code? */
    public static boolean needsSecondFactor(String method, boolean orgRequiresForPassword, int requestedLevel, boolean userHasOtp) {
        return needsSecondFactor(method, orgRequiresForPassword, requestedLevel, userHasOtp, false);
    }

    /** As above; OCN staff ({@link #STAFF_ROLE}) always need the second step, whatever the method. */
    public static boolean needsSecondFactor(String method, boolean orgRequiresForPassword, int requestedLevel, boolean userHasOtp, boolean staff) {
        if ("sso".equals(method)) return false;
        if (staff) return true;
        if (requestedLevel >= STRONG) return true;
        if (orgRequiresForPassword && "password".equals(method)) return true;
        // Someone who has set up an authenticator app is always asked for it.
        return userHasOtp;
    }
}
