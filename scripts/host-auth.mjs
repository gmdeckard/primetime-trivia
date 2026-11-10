/**
 * Logging a scripted browser into the big screen.
 *
 * `/host` stopped being open to anyone when the game moved to a public
 * hostname: ungated it served the live question, the team names, the wifi
 * password and the room code to whoever knew the address, and since the room
 * code is the whole join gate, that was also a seat on the scoreboard. The big
 * screen now carries the same token as the MC's phone.
 *
 * Every script here boots its own server with its own password, so logging in
 * is a fetch and one line of localStorage seeded before the page loads. Call
 * this before `goto('/host')`, never after: the page reads the token as it
 * mounts, and seeding it afterwards leaves the login on screen until a reload.
 */

/** Trade the password for a token, the way the login screen does. */
export async function hostToken(base, password) {
  const res = await fetch(`${base}/api/control/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`host login failed (${res.status}) — the big screen cannot be opened`);
  const { token } = await res.json();
  if (!token) throw new Error('host login returned no token');
  return token;
}

/**
 * Seed a page with the host token so `/host` opens straight onto the screen.
 *
 * Pass a token in when several pages share one, so a script with three host
 * windows does not log in three times.
 */
export async function seedHostToken(page, base, password, token) {
  const value = token ?? (await hostToken(base, password));
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('primetime.controlToken', t);
    } catch {
      /* storage off: the page will show the login and the script will say so */
    }
  }, value);
  return value;
}
