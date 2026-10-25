package technology.ocn.civicos.keycloak;

import jakarta.ws.rs.Consumes;
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
 * {@code POST /realms/<realm>/civicos-erasure/resend} with {@code { "sub": "...", "clientId": "..." }}
 * (client optional): send the account-erasure notice again, for a product that was down when the
 * account was deleted. Needs a bearer token of a user or service account holding the
 * realm-management role {@code manage-users}.
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
        AuthenticationManager.AuthResult auth = new AppAuthManager.BearerTokenAuthenticator(session).setRealm(realm).authenticate();
        if (auth == null) return Response.status(401).entity(Map.of("error", "bearer token required")).build();
        var rm = realm.getClientByClientId("realm-management");
        var role = rm == null ? null : rm.getRole("manage-users");
        if (role == null || !auth.getUser().hasRole(role)) return Response.status(403).entity(Map.of("error", "manage-users required")).build();
        String sub = body == null ? null : body.get("sub");
        if (sub == null || sub.isBlank()) return Response.status(400).entity(Map.of("error", "sub required")).build();
        if (session.users().getUserById(realm, sub) != null) return Response.status(409).entity(Map.of("error", "that account still exists")).build();
        List<String[]> calls = ErasureEventListener.signed(session, realm, sub, "resent by " + auth.getUser().getUsername(), body.get("clientId"));
        for (String[] c : calls) ErasureEventListener.send(c[0], c[1], c[2], sub);
        return Response.accepted(Map.of("sub", sub, "products", calls.stream().map(c -> c[0]).toList())).build();
    }

    @Override public void close() { }
}
