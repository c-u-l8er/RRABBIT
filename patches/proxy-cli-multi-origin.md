# `proxy/proxy-cli.js` — one allowed origin was one too few

**Applied directly to the vendored bundle**, unlike the `greenfield-*.diff`
patches: `proxy/proxy-cli.js` is committed to this repo, so an edit survives
`npm install`. It would NOT survive re-vendoring the bundle from
`@gfld/compositor-proxy`, which is why it is written down here.

## What was wrong

`--allow-origin`'s own help text says *"Value can be comma seperated domains"*.
It is not: the value was written into the response header verbatim, at five
sites, and `Access-Control-Allow-Origin` may name **exactly one** origin. A
comma-separated value is not a wildcard — it is a header no browser matches, so
a list refused *every* origin on it.

## Why it mattered here

The shell is served from two ports **by design**:

- `http://127.0.0.1:8911` — vite, while iterating;
- `http://127.0.0.1:8913` — `bridge.py` serving the built bundle, which is also
  the origin **inside the T&R image**.

`tools/proxy.sh` allowed 8911 only. Launching a native program from the built
shell therefore failed — and failed as **"compositor-proxy is not answering"**
while the proxy was answering perfectly well, on a page that had no way to tell
the difference (see the `THERE IS NO PROBE` note in `m2/shell.js`). That is the
worst shape a message can have: confidently wrong, about the wrong component.

## The change

A `pickAllowOrigin(config, request)` helper, inserted above `handleOptions`, and
the five `"Access-Control-Allow-Origin": config.server.http.allowOrigin` sites
changed to call it. It splits the configured value on commas and echoes the
request's own `Origin` when it is on the list, falling back to the first entry so
a request without an `Origin` header behaves exactly as before.

No `Vary: Origin`: there is no cache between a browser and a loopback socket, and
adding it would be five more header literals to keep in step.

## Verify

```bash
npm run proxy      # now defaults to allowing 8911 AND 8913
for O in http://127.0.0.1:8911 http://127.0.0.1:8913; do
  curl -s -D- -o /dev/null -X OPTIONS -H "Origin: $O" \
       -H 'Access-Control-Request-Method: GET' http://127.0.0.1:8912/ \
    | grep -i access-control-allow-origin
done
```

Each must echo back the origin it was sent. Both did.
