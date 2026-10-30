# Payments

The server no longer exposes a wallet: there is no `paymentWallet` RPC, no wallet settings in any client, and `me` no longer reports a wallet provider. Users cannot connect or disconnect a wallet, so bots are never offered `request_purchase`, `purchase_status` or `paid_request`.

Stored wallet connections in the `payment_wallets` table are kept as they are. Nothing reads or changes them through the API.

`PAYMENT_WALLET_PROVIDER` and `PAYMENT_WALLET_CLIENT_ID` are still read by the API and worker for the purchase adapters. Leave them unset (the default is `none`).
