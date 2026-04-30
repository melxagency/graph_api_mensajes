/**
 * FB AI Responder
 * Supabase → páginas activas → conversaciones Facebook → IA → responde
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

const REPLIED_CACHE = new Set();

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function supabaseQuery(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supabaseInsert(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function getPagesWithContext() {
  const services = await supabaseQuery(
    `pages_services?select=id,id_pagina,id_contrato,contratos_servicios(id,id_cliente,clientes(id,cliente,negocio,contacto,email,contexto))&fecha_termino=is.null&order=id`
  );
  const pages = await supabaseQuery(
    `pages?select=id,id_page,token,nombre,date_expire_token`
  );

  const pagesMap = {};
  for (const p of pages) pagesMap[p.id] = p;

  const result = [];
  const seenPageIds = new Set();

  for (const svc of services) {
    const page = pagesMap[svc.id_pagina];
    if (!page?.token || !page?.id_page) continue;

    if (page.date_expire_token && new Date(page.date_expire_token) < new Date()) {
      console.warn(`   ⚠️  Token expirado: ${page.nombre}`);
      continue;
    }

    const pageIdStr = String(page.id_page);
    if (seenPageIds.has(pageIdStr)) continue;
    seenPageIds.add(pageIdStr);

    const cliente = svc.contratos_servicios?.clientes;

    result.push({
      paginaId: page.id,
      pageId: pageIdStr,
      token: page.token,
      nombrePagina: page.nombre,
      negocio: cliente?.negocio || cliente?.cliente || "",
      contacto: cliente?.contacto || "",
      email: cliente?.email || "",
      contexto: cliente?.contexto || "",
    });
  }
  return result;
}

async function loadRepliedMap() {
  try {
    const since = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    const data = await supabaseQuery(
      `ai_replies_log?select=conversation_id,replied_at&replied_at=gte.${since}&order=replied_at.desc`
    );
    const map = new Map();
    for (const r of data) {
      if (!map.has(r.conversation_id)) {
        map.set(r.conversation_id, new Date(r.replied_at).getTime());
      }
    }
    console.log(`✅ Conversaciones respondidas en últimas 23h: ${map.size}`);
    return map;
  } catch (e) {
    console.warn("⚠️  No se pudo cargar ai_replies_log:", e.message);
    return new Map();
  }
}

// ─── Facebook Graph API ───────────────────────────────────────────────────────

async function fbGet(path, token) {
  const url = `https://graph.facebook.com/v19.0/${path}${path.includes("?") ? "&" : "?"}access_token=${token}`;
  const res = await fetch(url);
  return res.json();
}

async function fbPost(path, token, body) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  return res.json();
}

async function getConversations(pageId, token) {
  const data = await fbGet(
    `${pageId}/conversations?fields=id,updated_time,messages.limit(15){id,message,from,created_time}&limit=20`,
    token
  );
  return data.data || [];
}

// ─── Analizar mensajes pendientes ─────────────────────────────────────────────

function getPendingMessages(conv, pageId, repliedMap) {
  const messages = conv.messages?.data || [];
  if (messages.length === 0) return null;

  if (REPLIED_CACHE.has(conv.id)) return null;

  // El último mensaje debe ser del usuario (no de la página)
  const lastMsg = messages[messages.length - 1];
  if (String(lastMsg.from?.id) === String(pageId)) return null;

  // Debe estar dentro de la ventana de 23h
  const lastMsgTime = new Date(lastMsg.created_time).getTime();
  if ((Date.now() - lastMsgTime) / 3600000 > 23) return null;

  // Calcular desde cuándo hay mensajes nuevos del usuario
  // Si ya respondimos antes, solo tomamos mensajes POSTERIORES a esa respuesta
  let cutoffTime = 0;
  if (repliedMap.has(conv.id)) {
    cutoffTime = repliedMap.get(conv.id);
    if (lastMsgTime <= cutoffTime) return null; // no hay nada nuevo
  }

  // Filtrar mensajes del usuario posteriores al cutoff y dentro de 23h
  const pending = messages.filter(m => {
    if (String(m.from?.id) === String(pageId)) return false;
    if (!m.message?.trim()) return false;
    const t = new Date(m.created_time).getTime();
    if (t <= cutoffTime) return false;
    if ((Date.now() - t) / 3600000 > 23) return false;
    return true;
  });

  return pending.length > 0 ? pending : null;
}

// ─── Generar respuesta con IA ─────────────────────────────────────────────────

async function generateReply(pending, allMessages, page) {
  const { nombrePagina, negocio, contacto, email, contexto, pageId } = page;

  // Historial completo para contexto
  const historial = allMessages
    .slice(-10)
    .map(m => {
      const rol = String(m.from?.id) === String(pageId) ? "Negocio" : "Cliente";
      return `${rol}: ${m.message}`;
    })
    .join("\n");

  // Mensajes nuevos del cliente sin respuesta
  const nuevosMensajes = pending.map(m => m.message.trim()).join("\n");

  const contactoInfo = [
    contacto ? `WhatsApp: ${contacto}` : "",
    email ? `Email: ${email}` : "",
  ].filter(Boolean).join(" | ");

  const system = `Eres el asistente de atención al cliente de "${nombrePagina}".
${negocio ? `Negocio: ${negocio}.` : ""}
${contactoInfo ? `Datos de contacto: ${contactoInfo}.` : ""}
${contexto ? `Información del negocio: ${contexto}.` : ""}

REGLAS:
- Escribe SOLO el mensaje para el cliente, sin razonamientos ni explicaciones
- Máximo 3 oraciones, directo y amable
- Mismo idioma que el cliente
- Si pide contacto o WhatsApp, proporciona los datos disponibles
- Si no tienes info específica, invita a contactar
- NO inventes precios ni datos que no tengas`;

  const user = `Historial:
${historial}

Nuevos mensajes del cliente sin respuesta:
${nuevosMensajes}

Responde directamente al cliente:`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      max_tokens: 200,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`DeepSeek: ${JSON.stringify(data.error)}`);

  let text = data.choices?.[0]?.message?.content?.trim();
  if (!text) return "Gracias por su mensaje. En breve nos pondremos en contacto con usted.";

  // Eliminar bloques de razonamiento que algunos modelos incluyen
  // Patrones: <think>...</think>, [thinking]...[/thinking], líneas con "Wait", "Hmm", "Let me"
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  text = text.replace(/\[thinking\][\s\S]*?\[\/thinking\]/gi, "");

  // Si hay un separador claro como "---" o línea en blanco tras razonamiento, tomar lo de después
  const separatorMatch = text.match(/(?:^|
)[-─]{3,}
([\s\S]+)$/);
  if (separatorMatch) text = separatorMatch[1];

  // Eliminar líneas que parezcan razonamiento interno
  const lines = text.split("
").filter(line => {
    const l = line.trim().toLowerCase();
    return !(
      l.startsWith("wait") ||
      l.startsWith("hmm") ||
      l.startsWith("let me") ||
      l.startsWith("i think") ||
      l.startsWith("actually") ||
      l.startsWith("no wait") ||
      l.startsWith("okay") ||
      l.startsWith("ok,") ||
      l.startsWith("so,") ||
      l.startsWith("the user") ||
      l.startsWith("it mentions") ||
      l.startsWith("i need to") ||
      l.startsWith("i should") ||
      l.match(/^[a-z].*thinking.*$/i)
    );
  });

  text = lines.join("
").trim();
  if (!text) return "Gracias por su mensaje. En breve nos pondremos en contacto con usted.";

  return text;
}

// ─── Log ──────────────────────────────────────────────────────────────────────

async function logReply(pageId, convId, userMsg, reply) {
  try {
    await supabaseInsert("ai_replies_log", {
      page_id: pageId,
      conversation_id: convId,
      user_message: userMsg,
      ai_reply: reply,
      replied_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("⚠️  Log error:", e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖 FB AI Responder — ${new Date().toISOString()}`);
  console.log("=".repeat(50));

  let pages;
  try {
    pages = await getPagesWithContext();
    console.log(`✅ Páginas activas: ${pages.length}`);
  } catch (e) {
    console.error("❌ Error Supabase:", e.message);
    process.exit(1);
  }

  if (!pages.length) return;

  const repliedMap = await loadRepliedMap();
  let totalReplied = 0;
  let totalErrors = 0;

  for (const page of pages) {
    console.log(`\n📄 ${page.nombrePagina} (${page.pageId})`);

    try {
      const conversations = await getConversations(page.pageId, page.token);
      console.log(`   Conversaciones: ${conversations.length}`);

      for (const conv of conversations) {
        const pending = getPendingMessages(conv, page.pageId, repliedMap);
        if (!pending) continue;

        const lastMsg = pending[pending.length - 1];
        const combinedText = pending.map(m => m.message.trim()).join("\n");

        console.log(`\n   💬 ${conv.id}`);
        console.log(`   👤 ${lastMsg.from?.name} (${pending.length} msg pendiente${pending.length > 1 ? "s" : ""})`);
        console.log(`   📝 "${combinedText.substring(0, 120)}"`);

        try {
          const reply = await generateReply(pending, conv.messages?.data || [], page);
          console.log(`   🤖 "${reply.substring(0, 120)}"`);

          const result = await fbPost("me/messages", page.token, {
            recipient: { id: lastMsg.from?.id },
            message: { text: reply },
            messaging_type: "RESPONSE",
          });

          if (result.error) {
            console.error(`   ❌ FB: ${result.error.message}`);
            totalErrors++;
          } else {
            console.log(`   ✅ Enviado`);
            REPLIED_CACHE.add(conv.id);
            repliedMap.set(conv.id, Date.now());
            totalReplied++;
            await logReply(page.pageId, conv.id, combinedText, reply);
          }

          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          console.error(`   ❌ ${e.message}`);
          totalErrors++;
        }
      }
    } catch (e) {
      console.error(`   ❌ Página ${page.pageId}: ${e.message}`);
      totalErrors++;
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  console.log("\n" + "=".repeat(50));
  console.log(`✅ Enviadas: ${totalReplied} | ❌ Errores: ${totalErrors}`);
  console.log(`⏰ ${new Date().toISOString()}\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });