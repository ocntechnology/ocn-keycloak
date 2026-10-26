<#import "template.ftl" as layout>
<#import "buttons.ftl" as buttons>
<@layout.registrationLayout displayMessage=true; section>
<!-- template: civicos-code.ftl (CivicOS sign-in policy) -->
    <#if section = "header">
        <#if civicosMailboxCheck>${msg("civicosMailboxTitle")}<#else>${msg("civicosCodeTitle")}</#if>
    <#elseif section = "form">
        <p id="code-hint" class="civicos-signed-as"><#if civicosMailboxCheck>${msg("civicosMailboxIntro")} </#if>${msg("civicosCodeSentTo")} <strong>${civicosEmail}</strong>. ${msg("civicosCodeLasts")}</p>
        <form id="civicos-code-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormGroupClass!}">
                <div class="${properties.kcFormGroupLabelClass!}">
                    <label for="code" class="${properties.kcFormLabelClass!}"><span class="${properties.kcFormLabelTextClass!}">${msg("civicosCodeLabel")}</span></label>
                </div>
                <span class="${properties.kcInputClass!} <#if message?? && message.type = 'error'>${properties.kcError!}</#if>">
                    <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" autocomplete="one-time-code" autofocus
                           aria-describedby="code-hint" <#if message?? && message.type = 'error'>aria-invalid="true"</#if> />
                </span>
            </div>
            <@buttons.actionGroup>
                <button class="${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-verify" name="verify" type="submit">${msg("civicosContinue")}</button>
                <button class="${properties.kcButtonSecondaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-resend" name="resend" value="1" type="submit" formnovalidate>${msg("civicosResend")}</button>
            </@buttons.actionGroup>
            <button class="civicos-link" name="restart" value="1" type="submit" formnovalidate>${msg("civicosDifferentEmail")}</button>
        </form>
    </#if>
</@layout.registrationLayout>
