package technology.ocn.civicos.keycloak;

import java.util.Locale;

/** An organisation's sign-in policy, stored as the Keycloak organisation attribute {@code signInPolicy}. */
public enum SignInPolicy {
    OPEN("open"), SSO_AVAILABLE("sso_available"), SSO_REQUIRED("sso_required");

    public final String value;

    SignInPolicy(String value) { this.value = value; }

    public static SignInPolicy parse(String raw) {
        if (raw == null) return OPEN;
        String v = raw.trim().toLowerCase(Locale.ROOT).replace('-', '_');
        for (SignInPolicy p : values()) if (p.value.equals(v)) return p;
        return OPEN;
    }

    public boolean allowsPasswordAndCode() { return this != SSO_REQUIRED; }

    public static SignInPolicy strictest(SignInPolicy a, SignInPolicy b) { return a.ordinal() >= b.ordinal() ? a : b; }
}
