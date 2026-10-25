package technology.ocn.civicos.keycloak;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.Map;
import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;

/**
 * {@code POST /realms/<realm>/civicos-admin/code-limits/reset} with {@code { "email": "..." }}:
 * lift the email-code limits and the wrong-code lock for one address (support, and the
 * integration tests). Needs a bearer token with realm-management {@code manage-users}.
 */
public class SupportResource implements RealmResourceProvider {
    public static final String ID = "civicos-admin";
    private final KeycloakSession session;

    public SupportResource(KeycloakSession session) { this.session = session; }

    @Override public Object getResource() { return this; }

    @POST
    @Path("code-limits/reset")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response resetCodeLimits(Map<String, String> body) {
        RealmModel realm = session.getContext().getRealm();
        Response denied = Support.requireManageUsers(session, realm);
        if (denied != null) return denied;
        String email = body == null ? null : EmailDomains.normalise(body.get("email"));
        if (email == null) return Response.status(400).entity(Map.of("error", "email required")).build();
        CodeLimits.reset(CodeLimits.keycloak(session), realm.getId(), email);
        return Response.noContent().build();
    }

    @Override public void close() { }

    public static class Factory implements RealmResourceProviderFactory {
        @Override public RealmResourceProvider create(KeycloakSession session) { return new SupportResource(session); }
        @Override public void init(Config.Scope config) { }
        @Override public void postInit(KeycloakSessionFactory factory) { }
        @Override public void close() { }
        @Override public String getId() { return ID; }
    }
}
