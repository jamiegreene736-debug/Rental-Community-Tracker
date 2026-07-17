// Non-secret operator identity used for every buy-in checkout. Keep this in
// one shared module so Cowork prompts and any checkout path cannot silently
// drift to different traveler or billing values.
export const BUY_IN_CHECKOUT_PHONE = "8084606509";

export const BUY_IN_CHECKOUT_BILLING_ADDRESS = Object.freeze({
  street: "131 Continental Drive",
  city: "Newark",
  state: "DE",
  postalCode: "19702",
  country: "US",
});

export const BUY_IN_CHECKOUT_BILLING_ADDRESS_LINE =
  `${BUY_IN_CHECKOUT_BILLING_ADDRESS.street}, ${BUY_IN_CHECKOUT_BILLING_ADDRESS.city}, ` +
  `${BUY_IN_CHECKOUT_BILLING_ADDRESS.state} ${BUY_IN_CHECKOUT_BILLING_ADDRESS.postalCode}, ` +
  BUY_IN_CHECKOUT_BILLING_ADDRESS.country;
