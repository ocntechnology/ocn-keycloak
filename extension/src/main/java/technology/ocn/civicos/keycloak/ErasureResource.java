package technology.ocn.civicos.keycloak;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.List;
import java.util.Map;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.services.resource.RealmResourceProvider;

/**
 * {@code POST /realms/<realm>/civicos-erasure/resend} with {@code { "sub": "...", "clientId": "...", "email": "..." }}
 * (client and email optional; the email goes into the token): send the account-erasure notice again, for a product that was down when the
 * account was deleted; {@code GET .../civicos-erasure/pending} lists notices not yet delivered.
 * Both need a bearer token of a user or service account holding the realm-management role
 * {@code manage-users}.
 */
public class ErasureResource implements RealmResourceProvider {
    private final KeycloakSession session;

    public ErasureResource(KeycloakSession session) { this.session = session; }

    @Override public Object getResource() { return this; }

    @POST
    @Path("resend")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response resend(Map<String, String> body) {
        RealmModel realm = session.getContext().getRealm();
        Response denied = Support.requireManageUsers(session, realm);
        if (denied != null) return denied;
        AuthenticationManager.AuthResult auth = new AppAuthManager.BearerTokenAuthenticator(session).setRealm(realm).authenticate();
        String sub = body == null ? null : body.get("sub");
        if (sub == null || sub.isBlank()) return Response.status(400).entity(Map.of("error", "sub required")).build();
        if (session.users().getUserById(realm, sub) != null) return Response.status(409).entity(Map.of("error", "that account still exists")).build();
        String only = body.get("clientId");
        List<String> ids = ErasureOutbox.enqueue(session, realm, sub, EmailDomains.normalise(body.get("email")), "resent by " + auth.getUser().getUsername(), only == null || only.isBlank() ? null : only);
        List<String> products = ErasureOutbox.list(session, realm).stream().filter(m -> ids.contains(m.get("id"))).map(m -> (String) m.get("clientId")).toList();
        var factory = session.getKeycloakSessionFactory();
        session.getTransactionManager().enlistAfterCompletion(new org.keycloak.models.AbstractKeycloakTransaction() {
            @Override protected void commitImpl() { ErasureOutbox.sendSoon(factory, ids); }
            @Override protected void rollbackImpl() { }
        });
        return Response.accepted(Map.of("sub", sub, "products", products)).build();
    }

    /** Every erasure notice not yet delivered (pending, or failed and waiting for a resend). */
    @GET
    @Path("pending")
    @Produces(MediaType.APPLICATION_JSON)
    public Response pending() {
        RealmModel realm = session.getContext().getRealm();
        Response denied = Support.requireManageUsers(session, realm);
        if (denied != null) return denied;
        return Response.ok(ErasureOutbox.list(session, realm)).build();
    }

    @Override public void close() { }
}
