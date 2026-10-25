package technology.ocn.civicos.keycloak;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.keycloak.models.IdentityProviderModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.UserModel;
import org.keycloak.organization.OrganizationProvider;

/**
 * Finds the organisations for an email domain from Keycloak Organizations, which the council
 * registry keeps in step. A domain belongs to one organisation, except shared-service
 * domains (for example richmondandwandsworth.gov.uk), which Keycloak cannot give to two
 * organisations: those are listed in each organisation's {@code sharedDomains} attribute.
 */
public final class Orgs {
    public static final String A_POLICY = "signInPolicy";
    public static final String A_SECOND = "requireSecondFactor";
    public static final String A_SHARED = "sharedDomains";

    private Orgs() {}

    public static List<OrganizationModel> forDomain(KeycloakSession session, String domain) {
        OrganizationProvider p = session.getProvider(OrganizationProvider.class);
        List<OrganizationModel> out = new ArrayList<>();
        if (p == null || !p.isEnabled() || domain == null || domain.isBlank()) return out;
        OrganizationModel byDomain = p.getByDomainName(domain);
        if (byDomain != null && byDomain.isEnabled()) out.add(byDomain);
        p.getAllStream(Map.of(A_SHARED, domain), 0, 20)
            .filter(OrganizationModel::isEnabled)
            .filter(o -> out.stream().noneMatch(x -> x.getId().equals(o.getId())))
            .forEach(out::add);
        return out;
    }

    public static OrgPolicy policyFor(KeycloakSession session, String domain) {
        List<OrgPolicy.Org> orgs = new ArrayList<>();
        for (OrganizationModel o : forDomain(session, domain)) orgs.add(toOrg(o));
        return OrgPolicy.combine(orgs);
    }

    static OrgPolicy.Org toOrg(OrganizationModel o) {
        Map<String, List<String>> attrs = o.getAttributes();
        List<String> idps = o.getIdentityProviders().filter(IdentityProviderModel::isEnabled).map(IdentityProviderModel::getAlias).toList();
        return new OrgPolicy.Org(o.getAlias(), SignInPolicy.parse(first(attrs, A_POLICY)), "true".equalsIgnoreCase(first(attrs, A_SECOND)), idps);
    }

    static String first(Map<String, List<String>> attrs, String key) {
        if (attrs == null) return null;
        List<String> v = attrs.get(key);
        return v == null || v.isEmpty() ? null : v.get(0);
    }

    /** Domains an organisation owns, including shared ones. */
    public static List<String> domainsOf(OrganizationModel o) {
        List<String> d = new ArrayList<>(o.getDomains().map(x -> x.getName().toLowerCase()).toList());
        List<String> shared = o.getAttributes() == null ? null : o.getAttributes().get(A_SHARED);
        if (shared != null) for (String s : shared) d.add(s.toLowerCase());
        return d;
    }

    /** Make the person a member of the organisation their domain belongs to (not for shared domains). */
    public static void ensureMember(KeycloakSession session, UserModel user, String alias) {
        if (alias == null || user == null) return;
        OrganizationProvider p = session.getProvider(OrganizationProvider.class);
        if (p == null || !p.isEnabled()) return;
        OrganizationModel o = p.getByAlias(alias);
        if (o != null && !p.isMember(o, user)) p.addMember(o, user);
    }
}
