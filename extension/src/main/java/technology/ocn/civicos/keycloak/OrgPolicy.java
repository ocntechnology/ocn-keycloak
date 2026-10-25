package technology.ocn.civicos.keycloak;

import java.util.ArrayList;
import java.util.List;

/**
 * The policy that applies to one email domain: from one organisation, or several when a
 * shared-service domain belongs to more than one (then the strictest wins).
 */
public record OrgPolicy(List<String> aliases, SignInPolicy policy, boolean requireSecondFactor, List<String> idpAliases) {

    public static final OrgPolicy NONE = new OrgPolicy(List.of(), SignInPolicy.OPEN, false, List.of());

    public boolean registered() { return !aliases.isEmpty(); }

    public boolean ssoConnected() { return !idpAliases.isEmpty(); }

    /** The single organisation this domain belongs to, or null for none or a shared domain. */
    public String singleAlias() { return aliases.size() == 1 ? aliases.get(0) : null; }

    public record Org(String alias, SignInPolicy policy, boolean requireSecondFactor, List<String> idpAliases) {}

    public static OrgPolicy combine(List<Org> orgs) {
        if (orgs.isEmpty()) return NONE;
        List<String> aliases = new ArrayList<>();
        List<String> idps = new ArrayList<>();
        SignInPolicy policy = SignInPolicy.OPEN;
        boolean second = false;
        for (Org o : orgs) {
            aliases.add(o.alias());
            for (String i : o.idpAliases()) if (!idps.contains(i)) idps.add(i);
            policy = SignInPolicy.strictest(policy, o.policy());
            second |= o.requireSecondFactor();
        }
        return new OrgPolicy(List.copyOf(aliases), policy, second, List.copyOf(idps));
    }
}
