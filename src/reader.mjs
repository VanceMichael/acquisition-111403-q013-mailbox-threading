export async function collect(client) {
 const document=await client("/message");
 return [{id:document.messageId,...document}];
}
