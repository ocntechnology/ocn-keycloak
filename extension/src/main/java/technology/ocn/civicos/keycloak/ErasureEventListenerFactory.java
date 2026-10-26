package technology.ocn.civicos.keycloak;

import org.jboss.logging.Logger;
import org.keycloak.Config;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventListenerProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.UserModel;
import org.keycloak.models.utils.PostMigrationEvent;
import org.keycloak.timer.TimerProvider;

/**
 * Registers {@link ErasureEventListener} as event listener {@code civicos-erasure}. Once Keycloak
 * has started, it also schedules the erasure outbox timer and runs the start-up SMTP check.
 */
public class ErasureEventListenerFactory implements EventListenerProviderFactory {
    private static final Logger LOG = Logger.getLogger(ErasureEventListenerFactory.class);

    @Override public EventListenerProvider create(KeycloakSession session) { return new ErasureEventListener(session); }
    @Override public void init(Config.Scope config) { }

    @Override
    public void postInit(KeycloakSessionFactory factory) {
        factory.register(event -> {
            // Remember the email of an account about to be deleted: the erasure notice carries it.
            if (event instanceof UserModel.UserPreRemovedEvent e && e.getUser() != null && e.getUser().getEmail() != null) {
                e.getKeycloakSession().setAttribute(ErasureEventListener.EMAIL_NOTE + e.getUser().getId(), e.getUser().getEmail());
                return;
            }
            if (!(event instanceof PostMigrationEvent)) return;
            try (KeycloakSession s = factory.create()) {
                s.getProvider(TimerProvider.class).schedule(() -> {
                    try { ErasureOutbox.sendDue(factory); } catch (RuntimeException e) { LOG.warnf(e, "CivicOS erasure: outbox run failed"); }
                }, ErasureOutbox.TICK_SECONDS * 1000, "civicos-erasure-outbox");
            }
            SmtpCheck.runInBackground(factory);
        });
    }

    @Override public void close() { }
    @Override public String getId() { return ErasureEventListener.ID; }
}
