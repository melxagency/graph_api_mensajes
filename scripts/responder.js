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
 * Trae todas las páginas activas con token + info completa del cliente
 * JOIN: pages_services → pages → contratos_servicios → clientes
 * Incluye: negocio, contacto, email, contexto del cliente
 */
async function getPagesWithContext() {
  // Traemos pages_services activos (fecha_termino nula) con toda la info del cliente
  const services = await supabaseQuery(
    `pages_services?select=id,id_pagina,id_contrato,contratos_servicios(id,id_cliente,clientes(id,cliente,negocio,contacto,email,contexto))&fecha_termino=is.null&order=id`
  );

  // Traemos la tabla pages para obtener token e id_page de Facebook
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