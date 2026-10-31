const response = http.get(`${RAKAZO_API_URL.replace(/\/$/, "")}/api/dev/emails`);
const messages = json(response.body);
const email = messages.filter((message) => message.to === RAKAZO_ACTIVE_EMAIL).pop();
const code = email?.text.match(/\b\d{6}\b/);
if (!code) throw new Error("No local sign-in code for screenshot account");
output.signInCode = code[0];
