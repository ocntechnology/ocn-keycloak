package technology.ocn.civicos.keycloak;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;

/** Registers {@link ErasureResource} at /realms/<realm>/civicos-erasure. */
public class ErasureResourceFactory implements RealmResourceProviderFactory {
    @Override public RealmResourceProvider create(KeycloakSession session) { return new ErasureResource(session); }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
    @Override public String getId() { return "civicos-erasure"; }
}
