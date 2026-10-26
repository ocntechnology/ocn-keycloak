<#import "template.ftl" as layout>
<#import "buttons.ftl" as buttons>
<@layout.registrationLayout displayMessage=true; section>
<!-- template: civicos-otp.ftl (CivicOS sign-in policy) -->
    <#if section = "header">
        ${msg("civicosOtpTitle")}
    <#elseif section = "form">
        <p id="otp-hint" class="civicos-signed-as">${msg("civicosOtpIntro")}</p>
        <form id="civicos-otp-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormGroupClass!}">
                <div class="${properties.kcFormGroupLabelClass!}">
                    <label for="otp" class="${properties.kcFormLabelClass!}"><span class="${properties.kcFormLabelTextClass!}">${msg("civicosOtpLabel")}</span></label>
                </div>
                <span class="${properties.kcInputClass!} <#if message?? && message.type = 'error'>${properties.kcError!}</#if>">
                    <input id="otp" name="otp" type="text" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" autocomplete="one-time-code" autofocus aria-describedby="otp-hint" <#if message?? && message.type = 'error'>aria-invalid="true"</#if> />
                </span>
            </div>
            <@buttons.actionGroup>
                <button class="${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-otp-submit" name="login" type="submit">${msg("civicosContinue")}</button>
            </@buttons.actionGroup>
        </form>
    </#if>
</@layout.registrationLayout>
