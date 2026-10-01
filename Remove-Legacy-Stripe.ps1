$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (!(Test-Path "netlify.toml") -or !(Test-Path "netlify/functions/paypal-create-order.mjs")) { throw "Run this from the updated PayPal repository." }
$branch = git branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch.Trim() -cne "Preview") { throw "Select the Preview branch before removing legacy functions." }
if (Test-Path "netlify/functions/create-checkout-session.mjs") { Remove-Item "netlify/functions/create-checkout-session.mjs" }
if (Test-Path "netlify/functions/create-credit-payout.js") { Remove-Item "netlify/functions/create-credit-payout.js" }
if (Test-Path "netlify/functions/create-roaster-funding-payout.js") { Remove-Item "netlify/functions/create-roaster-funding-payout.js" }
if (Test-Path "netlify/functions/refund-order.js") { Remove-Item "netlify/functions/refund-order.js" }
if (Test-Path "netlify/functions/stripe-payout-info.js") { Remove-Item "netlify/functions/stripe-payout-info.js" }
if (Test-Path "netlify/functions/stripe-webhook.mjs") { Remove-Item "netlify/functions/stripe-webhook.mjs" }
if (Test-Path "sandbox/functions") { Remove-Item "sandbox/functions" -Recurse }
Write-Host "Legacy runtime functions removed. Review, commit and sync the Preview changes."
