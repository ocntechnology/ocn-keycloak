package technology.ocn.civicos.keycloak;

import jakarta.ws.rs.core.Response;
import java.util.Map;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager;

/** Shared checks for the CivicOS support endpoints. */
final class Support {
    private Support() {}

    /** Null if the bearer token belongs to someone with realm-management manage-users, else the error response. */
    static Response requireManageUsers(KeycloakSession session, RealmModel realm) {
        AuthenticationManager.AuthResult auth = new AppAuthManager.BearerTokenAuthenticator(session).setRealm(realm).authenticate();
        if (auth == null) return Response.status(401).entity(Map.of("error", "bearer token required")).build();
        var rm = realm.getClientByClientId("realm-management");
        var role = rm == null ? null : rm.getRole("manage-users");
        if (role == null || !auth.getUser().hasRole(role)) return Response.status(403).entity(Map.of("error", "manage-users required")).build();
        return null;
    }
}
