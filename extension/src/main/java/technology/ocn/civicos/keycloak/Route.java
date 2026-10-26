package technology.ocn.civicos.keycloak;

/** What the identity screen does with an email address. Pure decision, tested in RouteTest. */
public final class Route {
    public enum Kind { INVALID_EMAIL, PERSONAL_EMAIL, UNKNOWN_DOMAIN, ACCOUNT_DISABLED, SSO_NOT_CONNECTED, SSO_REDIRECT, CHOOSE, PASSWORD, CODE }

    public final Kind kind;
    public final String idpAlias;
    /** For CHOOSE: whether password is offered (only if the person has one). */
    public final boolean offerPassword;

    private Route(Kind kind, String idpAlias, boolean offerPassword) {
        this.kind = kind;
        this.idpAlias = idpAlias;
        this.offerPassword = offerPassword;
    }

    public static Route of(Kind k) { return new Route(k, null, false); }

    /**
     * @param email         normalised email, or null if invalid
     * @param org           policy for the email's domain (NONE if unregistered)
     * @param userExists    an account with this email exists (for example, invited)
     * @param userEnabled   that account is enabled
     * @param hasPassword   that account has a password
     */
    public static Route decide(String email, OrgPolicy org, boolean userExists, boolean userEnabled, boolean hasPassword) {
        if (email == null) return of(Kind.INVALID_EMAIL);
        if (EmailDomains.isPersonal(email)) return of(Kind.PERSONAL_EMAIL);
        if (!org.registered() && !userExists) return of(Kind.UNKNOWN_DOMAIN);
        if (userExists && !userEnabled) return of(Kind.ACCOUNT_DISABLED);
        switch (org.policy()) {
            case SSO_REQUIRED:
                return org.ssoConnected() ? new Route(Kind.SSO_REDIRECT, org.idpAliases().get(0), false) : of(Kind.SSO_NOT_CONNECTED);
            case SSO_AVAILABLE:
                if (org.ssoConnected()) return new Route(Kind.CHOOSE, org.idpAliases().get(0), userExists && hasPassword);
                break;
            default:
                break;
        }
        return userExists && hasPassword ? of(Kind.PASSWORD) : of(Kind.CODE);
    }
}
