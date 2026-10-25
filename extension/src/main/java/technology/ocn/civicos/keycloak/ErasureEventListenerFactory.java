package technology.ocn.civicos.keycloak;

import org.keycloak.Config;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventListenerProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

/** Registers {@link ErasureEventListener} as event listener {@code civicos-erasure}. */
public class ErasureEventListenerFactory implements EventListenerProviderFactory {
    @Override public EventListenerProvider create(KeycloakSession session) { return new ErasureEventListener(session); }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
    @Override public String getId() { return ErasureEventListener.ID; }
}
