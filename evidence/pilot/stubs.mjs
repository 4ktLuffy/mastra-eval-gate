// Local fake of open-meteo (the template tool uses global fetch). Counts calls.
export const fetchStats = { geo: 0, weather: 0, mode: 'ok', delayMs: 0 };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (fetchStats.delayMs) await new Promise(r => setTimeout(r, fetchStats.delayMs));
  if (u.includes('geocoding')) { fetchStats.geo++; if (fetchStats.mode === 'hang') return new Promise(() => {}); if (fetchStats.mode === 'throw') throw new Error('ECONNRESET'); return new Response(JSON.stringify({ results: [{ latitude: 1, longitude: 2, name: 'Paris' }] })); }
  fetchStats.weather++;
  if (fetchStats.mode === 'badshape') return new Response(JSON.stringify({ current: { temperature_2m: 'hot', apparent_temperature: 1, relative_humidity_2m: 1, wind_speed_10m: 1, wind_gusts_10m: 1, weather_code: 0 } }));
  return new Response(JSON.stringify({ current: { time: 'x', temperature_2m: 20, apparent_temperature: 19, relative_humidity_2m: 50, wind_speed_10m: 3, wind_gusts_10m: 5, weather_code: 1, precipitation: 0, weathercode: 1 }, hourly: { temperature_2m: [10, 20], precipitation_probability: [5, 30] } }));
};
