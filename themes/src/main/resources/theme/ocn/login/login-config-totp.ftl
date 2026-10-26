<#import "template.ftl" as layout>
<#import "buttons.ftl" as buttons>
<#-- CivicOS: setting up an authenticator app, in plain English. Same form fields as Keycloak's
     own page (totp, totpSecret, userLabel, mode), so the CONFIGURE_TOTP action works unchanged. -->
<@layout.registrationLayout displayRequiredFields=false displayMessage=!messagesPerField.existsError('totp','userLabel'); section>
<!-- template: login-config-totp.ftl (CivicOS) -->
    <#if section = "header">
        ${msg("loginTotpTitle")}
    <#elseif section = "form">
        <p class="civicos-signed-as">${msg("civicosTotpIntro")}</p>
        <ol id="kc-totp-settings" class="civicos-steps">
            <li>${msg("civicosTotpStep1")}</li>
            <#if mode?? && mode = "manual">
                <li>
                    ${msg("civicosTotpStep2Manual")}
                    <p><strong id="kc-totp-secret-key" class="civicos-key">${totp.totpSecretEncoded}</strong></p>
                    <p class="civicos-small"><a href="${totp.qrUrl}" id="mode-barcode">${msg("civicosTotpUseQr")}</a></p>
                </li>
            <#else>
                <li>
                    ${msg("civicosTotpStep2")}
                    <p><img id="kc-totp-secret-qr-code" src="data:image/png;base64, ${totp.totpSecretQrCode}" alt="${msg("civicosTotpQrAlt")}" width="200" height="200"></p>
                    <p class="civicos-small"><a href="${totp.manualUrl}" id="mode-manual">${msg("civicosTotpCannotScan")}</a></p>
                </li>
            </#if>
            <li>${msg("civicosTotpStep3")}</li>
        </ol>

        <form action="${url.loginAction}" class="${properties.kcFormClass!}" id="kc-totp-settings-form" method="post" novalidate="novalidate">
            <div class="${properties.kcFormGroupClass!}">
                <div class="${properties.kcFormGroupLabelClass!}">
                    <label for="totp" class="${properties.kcFormLabelClass!}"><span class="${properties.kcFormLabelTextClass!}">${msg("civicosTotpCodeLabel")}</span></label>
                </div>
                <span class="${properties.kcInputClass!} <#if messagesPerField.existsError('totp')>${properties.kcError!}</#if>">
                    <input type="text" id="totp" name="totp" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9 ]*" maxlength="7"
                           <#if messagesPerField.existsError('totp')>aria-invalid="true" aria-describedby="input-error-otp-code"</#if> />
                </span>
                <#if messagesPerField.existsError('totp')>
                    <span id="input-error-otp-code" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">${kcSanitize(messagesPerField.get('totp'))?no_esc}</span>
                </#if>
                <input type="hidden" id="totpSecret" name="totpSecret" value="${totp.totpSecret}" />
                <#if mode??><input type="hidden" id="mode" name="mode" value="${mode}"/></#if>
            </div>
            <div class="${properties.kcFormGroupClass!}">
                <div class="${properties.kcFormGroupLabelClass!}">
                    <label for="userLabel" class="${properties.kcFormLabelClass!}"><span class="${properties.kcFormLabelTextClass!}">${msg("civicosTotpNameLabel")}</span></label>
                </div>
                <span class="${properties.kcInputClass!} <#if messagesPerField.existsError('userLabel')>${properties.kcError!}</#if>">
                    <input type="text" id="userLabel" name="userLabel" autocomplete="off"
                           <#if messagesPerField.existsError('userLabel')>aria-invalid="true" aria-describedby="input-error-otp-label"</#if> />
                </span>
                <#if messagesPerField.existsError('userLabel')>
                    <span id="input-error-otp-label" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">${kcSanitize(messagesPerField.get('userLabel'))?no_esc}</span>
                </#if>
            </div>
            <@buttons.actionGroup>
                <button class="${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" id="saveTOTPBtn" type="submit">${msg("civicosTotpSave")}</button>
                <#if isAppInitiatedAction??>
                <button class="${properties.kcButtonSecondaryClass!} ${properties.kcButtonBlockClass!}" id="cancelTOTPBtn" name="cancel-aia" value="true" type="submit" formnovalidate>${msg("civicosCancel")}</button>
                </#if>
            </@buttons.actionGroup>
            <#if !isAppInitiatedAction??>
            <p class="civicos-small"><a id="civicos-totp-cancel" href="<#if (client.baseUrl)?has_content>${client.baseUrl}<#else>${url.loginRestartFlowUrl}</#if>">${msg("civicosCancel")}</a></p>
            </#if>
        </form>
    </#if>
</@layout.registrationLayout>
