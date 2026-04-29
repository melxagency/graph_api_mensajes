/**
 * FB AI Responder
 * Consulta Supabase → obtiene páginas activas → lee mensajes Facebook → responde con Claude
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const REPLIED_CACHE = new Set(); // evita responder dos veces en la misma ejecución

// ─── Supabase helpers ─────────────────────────────────────────────────────────

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

/**
 * Trae todas las páginas activas con token + info del cliente (negocio)
 * JOIN: pages_services → paginas → contratos_servicios → clientes
 */
async function getPagesWithContext() {
  // Traemos pages_services con fecha_termino nula o futura (contrato activo)
  const services = await supabaseQuery(
    `pages_services?select=id,id_pagina,id_contrato,contratos_servicios(id,id_cliente,clientes(id,cliente,negocio,contacto))&fecha_termino=is.null&order=id`
  );

  // Traemos la tabla de páginas para obtener el token y el id_page de Facebook
  const paginas = await supabaseQuery(
    `pages?select=id,id_page,token,nombre,date_expire_token`
  );

  const paginasMap = {};
  for (const p of paginas) paginasMap[p.id] = p;

  const result = [];
  for (const svc of services) {
    const pagina = paginasMap[svc.id_pagina];
    if (!pagina || !pagina.token || !pagina.id_page) continue;

    // Saltar páginas con token expirado
    if (pagina.date_expire_token) {
      const expiry = new Date(pagina.date_expire_token);
      if (expiry < new Date()) {
        console.warn(`   ⚠️  Token expirado para página ${pagina.nombre} (${pagina.date_expire_token}), saltando...`);
        continue;
      }
    }

    const contrato = svc.contratos_servicios;
    const cliente = contrato?.clientes;

    result.push({
      serviceId: svc.id,
      paginaId: pagina.id,
      pageId: String(pagina.id_page),  // ID real de Facebook
      token: pagina.token,
      nombrePagina: pagina.nombre,
      negocio: cliente?.negocio || cliente?.cliente || "negocio en Facebook",
      clienteNombre: cliente?.cliente || "",
    });
  }

  return result;
}

// ─── Facebook Graph API helpers ───────────────────────────────────────────────

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

/**
 * Trae conversaciones de la página con mensajes recientes
 */
async function getConversations(pageId, token) {
  const data = await fbGet(
    `${pageId}/conversations?fields=id,updated_time,messages{id,message,from,created_time,to}&limit=20`,
    token
  );
  return data.data || [];
}

/**
 * Verifica si la conversación necesita respuesta.
 * La Graph API devuelve mensajes de más antiguo a más reciente,
 * por lo que el ÚLTIMO elemento del array es el mensaje más reciente.
 */
function needsReply(conversation, pageId) {
  const messages = conversation.messages?.data || [];
  if (messages.length === 0) return false;

  // Si ya lo procesamos en esta ejecución
  if (REPLIED_CACHE.has(conversation.id)) return false;

  // El más reciente es el ÚLTIMO del array
  const lastMsg = messages[messages.length - 1];

  // Si el último mensaje lo envió la propia página, ya fue respondido
  if (String(lastMsg.from?.id) === String(pageId)) return false;

  // Ignorar mensajes muy viejos (más de 7 días = 168 horas)
  const msgTime = new Date(lastMsg.created_time).getTime();
  const hoursOld = (Date.now() - msgTime) / (1000 * 60 * 60);
  if (hoursOld > 168) return false;

  return true;
}

// ─── OpenRouter AI (gratis con modelos gratuitos) ─────────────────────────────

async function generateReply(userMessage, conversationHistory, negocio, paginaNombre) {
  const historyText = conversationHistory
    .slice(0, 6)
    .reverse()
    .map((m) => `${m.from?.name || "Usuario"}: ${m.message}`)
    .join("\n");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "HTTP-Referer": "https://github.com/fb-ai-responder",
      "X-Title": "FB AI Responder"
    },
    body: JSON.stringify({
      model: "openrouter/free",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: `Eres el asistente virtual de la página de Facebook "${paginaNombre}". El negocio es: ${negocio}. INSTRUCCIONES: Responde de forma amable, profesional y concisa (máximo 3 oraciones). Responde siempre en el mismo idioma del mensaje del usuario. Si preguntan por precios o disponibilidad específica que no conoces, invítalos a contactar directamente. No inventes información. Sé cálido y útil. Si es un saludo, responde con saludo y pregunta en qué puedes ayudar. No menciones que eres IA a menos que te lo pregunten.`
        },
        {
          role: "user",
          content: `Historial:\n${historyText}\n\nÚltimo mensaje: "${userMessage}"\n\nResponde:`
        }
      ]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(`OpenRouter error: ${JSON.stringify(data.error)}`);
  if (!data.choices?.[0]?.message?.content) throw new Error(`OpenRouter respuesta inesperada: ${JSON.stringify(data)}`);
  return data.choices[0].message.content.trim();
}

// ─── Registro en Supabase de mensajes respondidos ─────────────────────────────

async function logReply(pageId, conversationId, userMessage, reply) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ai_replies_log`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        page_id: pageId,
        conversation_id: conversationId,
        user_message: userMessage,
        ai_reply: reply,
        replied_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn("No se pudo registrar el log (tabla ai_replies_log opcional):", e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖 FB AI Responder — ${new Date().toISOString()}`);
  console.log("=".repeat(50));

  // 1. Obtener páginas activas desde Supabase
  let pages;
  try {
    pages = await getPagesWithContext();
    console.log(`✅ Páginas activas encontradas: ${pages.length}`);
  } catch (e) {
    console.error("❌ Error consultando Supabase:", e.message);
    process.exit(1);
  }

  if (pages.length === 0) {
    console.log("ℹ️  No hay páginas activas con contratos vigentes.");
    return;
  }

  let totalReplied = 0;
  let totalErrors = 0;

  // 2. Procesar cada página
  for (const page of pages) {
    console.log(`\n📄 Procesando: ${page.nombrePagina} (${page.pageId})`);
    console.log(`   Negocio: ${page.negocio}`);

    try {
      const conversations = await getConversations(page.pageId, page.token);
      console.log(`   Conversaciones encontradas: ${conversations.length}`);

      for (const conv of conversations) {
        // DEBUG: mostrar estado de cada conversación
        const dbgMsgs = conv.messages?.data || [];
        const dbgLast = dbgMsgs[dbgMsgs.length - 1]; // más reciente = último
        const dbgRecent = dbgMsgs.slice(-3).map(m => `${m.from?.id}(${m.from?.name?.substring(0,10)})`).join(', ');
        const dbgAge = dbgLast ? Math.round((Date.now() - new Date(dbgLast.created_time)) / 3600000) : '?';
        const dbgNeedsReply = String(dbgLast?.from?.id) !== String(page.pageId) && dbgAge <= 168;
        console.log(`   🔍 Conv ${conv.id.substring(0,20)}... | recientes: [${dbgRecent}] | hace ${dbgAge}h | ${dbgNeedsReply ? '✅ PENDIENTE' : '⏭ skip'}`);

        if (!needsReply(conv, page.pageId)) continue;

        const messages = conv.messages?.data || [];
        const lastMsg = messages[messages.length - 1]; // más reciente = último
        const userMessage = lastMsg.message;

        if (!userMessage || userMessage.trim() === "") continue;

        console.log(`\n   💬 Conversación: ${conv.id}`);
        console.log(`   👤 Usuario: ${lastMsg.from?.name}`);
        console.log(`   📝 Mensaje: "${userMessage.substring(0, 80)}..."`);

        try {
          // Generar respuesta con Claude
          const reply = await generateReply(
            userMessage,
            messages,
            page.negocio,
            page.nombrePagina
          );
          console.log(`   🤖 Respuesta IA: "${reply.substring(0, 80)}..."`);

          // Enviar respuesta via Graph API
          const result = await fbPost(
            `${conv.id}/messages`,
            page.token,
            { message: reply }
          );

          if (result.error) {
            console.error(`   ❌ Error enviando respuesta: ${result.error.message}`);
            totalErrors++;
          } else {
            console.log(`   ✅ Respuesta enviada (msg id: ${result.message_id})`);
            REPLIED_CACHE.add(conv.id);
            totalReplied++;

            // Registrar en Supabase (opcional)
            await logReply(page.pageId, conv.id, userMessage, reply);
          }

          // Pausa entre mensajes para respetar rate limit de Gemini free tier
          await new Promise((r) => setTimeout(r, 3000));

        } catch (e) {
          console.error(`   ❌ Error procesando conversación ${conv.id}:`, e.message);
          totalErrors++;
        }
      }
    } catch (e) {
      console.error(`   ❌ Error en página ${page.pageId}:`, e.message);
      totalErrors++;
    }

    // Pausa entre páginas para no saturar Gemini
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\n" + "=".repeat(50));
  console.log(`✅ Respuestas enviadas: ${totalReplied}`);
  console.log(`❌ Errores: ${totalErrors}`);
  console.log(`⏰ Finalizado: ${new Date().toISOString()}\n`);
}

main().catch((e) => {
  console.error("Error fatal:", e);
  process.exit(1);
});
