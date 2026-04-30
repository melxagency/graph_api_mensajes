/**
 * FB AI Responder
 * Supabase → páginas activas → conversaciones Facebook → IA → responde
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// Cache en memoria para evitar doble respuesta en la misma ejecución
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

/**
 * Trae páginas activas con toda la info del cliente
 * pages_services → pages + contratos_servicios → clientes
 */
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
  const seenPageIds = new Set(); // evitar duplicar misma página

  for (const svc of services) {
    const page = pagesMap[svc.id_pagina];
    if (!page?.token || !page?.id_page) continue;

    // Saltar token expirado
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
      clienteNombre: cliente?.cliente || "",
      negocio: cliente?.negocio || cliente?.cliente || "",
      contacto: cliente?.contacto || "",
      email: cliente?.email || "",
      contexto: cliente?.contexto || "",
    });
  }
  return result;
}

/**
 * Carga Map de conversaciones ya respondidas: conversation_id → timestamp replied_at
 * Solo las últimas 23h para comparar si el usuario escribió después
 */
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

// ─── Lógica de análisis de conversación ──────────────────────────────────────

/**
 * Determina si una conversación necesita respuesta y devuelve
 * los mensajes pendientes del usuario (escritos después de la última respuesta de la IA)
 */
function getPendingMessages(conversation, pageId, repliedMap) {
  const messages = conversation.messages?.data || [];
  if (messages.length === 0) return null;

  // Skip si ya procesamos en esta ejecución
  if (REPLIED_CACHE.has(conversation.id)) return null;

  // El último mensaje del array es el más reciente
  const lastMsg = messages[messages.length - 1];

  // Si el último mensaje es de la página, ya está respondido
  if (String(lastMsg.from?.id) === String(pageId)) return null;

  // Facebook solo permite responder en ventana de 24h (usamos 23h)
  const lastMsgTime = new Date(lastMsg.created_time).getTime();
  const hoursOld = (Date.now() - lastMsgTime) / 3600000;
  if (hoursOld > 23) return null;

  // Determinar desde qué punto hay mensajes nuevos del usuario
  // Si la IA ya respondió antes, buscar mensajes POSTERIORES a esa respuesta
  let cutoffTime = 0;
  if (repliedMap.has(conversation.id)) {
    cutoffTime = repliedMap.get(conversation.id);
    // Si el último mensaje del usuario es anterior o igual a la última respuesta → ya respondido
    if (lastMsgTime <= cutoffTime) return null;
  }

  // Recopilar mensajes del usuario posteriores al cutoff
  const pending = messages.filter(m => {
    if (String(m.from?.id) === String(pageId)) return false; // son de la página
    if (!m.message?.trim()) return false; // vacíos
    const t = new Date(m.created_time).getTime();
    if (t <= cutoffTime) return false; // anteriores a última respuesta
    const h = (Date.now() - t) / 3600000;
    if (h > 23) return false; // fuera de ventana
    return true;
  });

  if (pending.length === 0) return null;
  return pending;
}

// ─── IA: OpenRouter con modelo estable ───────────────────────────────────────

async function generateReply(pendingMessages, allMessages, page) {
  const { nombrePagina, negocio, contacto, email, contexto, pageId } = page;

  // Construir historial completo como contexto (últimos 10 mensajes)
  const historial = allMessages
    .slice(-10)
    .map(m => {
      const quien = String(m.from?.id) === String(pageId) ? "Página" : m.from?.name || "Cliente";
      return `${quien}: ${m.message}`;
    })
    .join("\n");

  // Mensajes pendientes que el usuario envió y aún no tienen respuesta
  const mensajesPendientes = pendingMessages
    .map(m => m.message.trim())
    .join("\n");

  const contactoInfo = [
    contacto ? `WhatsApp: ${contacto}` : "",
    email ? `Email: ${email}` : "",
  ].filter(Boolean).join(" | ");

  const systemPrompt = `Eres el asistente de atención al cliente de "${nombrePagina}".
${negocio ? `Negocio: ${negocio}.` : ""}
${contactoInfo ? `Contacto: ${contactoInfo}.` : ""}
${contexto ? `Información del negocio: ${contexto}.` : ""}

REGLAS ESTRICTAS:
- Responde ÚNICAMENTE con el mensaje para el cliente, sin explicaciones ni razonamientos
- Máximo 3 oraciones, directo y amable
- Usa el mismo idioma que el cliente
- Si preguntan contacto o WhatsApp, proporciona los datos disponibles
- Si no tienes información específica, invita a contactar por WhatsApp/email
- NO inventes precios ni información que no tengas
- NO escribas "Respuesta:", "AI:", ni nada similar, solo el texto del mensaje`;

  const userPrompt = `Historial de la conversación:
${historial}

El cliente acaba de enviar estos mensajes nuevos que aún no tienen respuesta:
${mensajesPendientes}

Escribe tu respuesta directamente:`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "HTTP-Referer": "https://github.com/fb-ai-responder",
      "X-Title": "FB AI Responder",
    },
    body: JSON.stringify({
      model: "google/gemma-3-12b-it:free",
      max_tokens: 200,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const data = await response.json();

  if (data.error) throw new Error(`OpenRouter: ${JSON.stringify(data.error)}`);

  const text = data.choices?.[0]?.message?.content;
  if (!text || text.trim() === "") {
    return "Gracias por su mensaje. En breve nos pondremos en contacto con usted.";
  }

  // Limpiar cualquier prefijo de razonamiento que pudiera colarse
  const cleaned = text
    .replace(/^(Respuesta:|AI:|Asistente:|Response:)\s*/i, "")
    .replace(/^(Wait|No wait|Hmm|Let me|I think|Actually).{0,200}\n/gi, "")
    .trim();

  return cleaned;
}

// ─── Log en Supabase ──────────────────────────────────────────────────────────

async function logReply(pageId, conversationId, userMessage, reply) {
  try {
    await supabaseInsert("ai_replies_log", {
      page_id: pageId,
      conversation_id: conversationId,
      user_message: userMessage,
      ai_reply: reply,
      replied_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("⚠️  No se pudo guardar log:", e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖 FB AI Responder — ${new Date().toISOString()}`);
  console.log("=".repeat(50));

  // 1. Páginas activas
  let pages;
  try {
    pages = await getPagesWithContext();
    console.log(`✅ Páginas activas: ${pages.length}`);
  } catch (e) {
    console.error("❌ Error Supabase:", e.message);
    process.exit(1);
  }

  if (pages.length === 0) {
    console.log("ℹ️  No hay páginas activas.");
    return;
  }

  // 2. Cargar conversaciones ya respondidas (con timestamps)
  const repliedMap = await loadRepliedMap();

  let totalReplied = 0;
  let totalErrors = 0;

  // 3. Procesar cada página
  for (const page of pages) {
    console.log(`\n📄 ${page.nombrePagina} (${page.pageId})`);

    try {
      const conversations = await getConversations(page.pageId, page.token);
      console.log(`   Conversaciones: ${conversations.length}`);

      for (const conv of conversations) {
        // Analizar si hay mensajes pendientes del usuario
        const pending = getPendingMessages(conv, page.pageId, repliedMap);
        if (!pending) continue;

        const lastUserMsg = pending[pending.length - 1];
        const recipientId = lastUserMsg.from?.id;
        const userName = lastUserMsg.from?.name;
        const combinedText = pending.map(m => m.message.trim()).join("\n");
        const allMessages = conv.messages?.data || [];

        console.log(`\n   💬 ${conv.id}`);
        console.log(`   👤 ${userName} (${pending.length} mensaje${pending.length > 1 ? "s" : ""} pendiente${pending.length > 1 ? "s" : ""})`);
        console.log(`   📝 "${combinedText.substring(0, 100)}"`);

        try {
          const reply = await generateReply(pending, allMessages, page);
          console.log(`   🤖 "${reply.substring(0, 100)}"`);

          const result = await fbPost("me/messages", page.token, {
            recipient: { id: recipientId },
            message: { text: reply },
            messaging_type: "RESPONSE",
          });

          if (result.error) {
            console.error(`   ❌ FB error: ${result.error.message}`);
            totalErrors++;
          } else {
            console.log(`   ✅ Enviado`);
            REPLIED_CACHE.add(conv.id);
            // Actualizar el map en memoria para esta ejecución
            repliedMap.set(conv.id, Date.now());
            totalReplied++;
            await logReply(page.pageId, conv.id, combinedText, reply);
          }

          await new Promise(r => setTimeout(r, 2000));

        } catch (e) {
          console.error(`   ❌ Error: ${e.message}`);
          totalErrors++;
        }
      }
    } catch (e) {
      console.error(`   ❌ Error página ${page.pageId}: ${e.message}`);
      totalErrors++;
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  console.log("\n" + "=".repeat(50));
  console.log(`✅ Respuestas enviadas: ${totalReplied}`);
  console.log(`❌ Errores: ${totalErrors}`);
  console.log(`⏰ ${new Date().toISOString()}\n`);
}

main().catch(e => {
  console.error("Error fatal:", e);
  process.exit(1);
});
