# devtool.awantech.sk

Static pages for the iOS app: the landing/support page (`index.html`) and the privacy policy (`privacy/index.html`, linked from App Store Connect). Plain HTML and one stylesheet, no build step.

On awantech.sk they are served by the `devtool-site` container (`caddy file-server`) from `~/services/devtool-relay/site`, behind the shared Caddy. To publish a change:

```bash
rsync -a --delete site/ awantech.sk:services/devtool-relay/site/
```

Keep the privacy policy in step with what the app, relay and push gateway actually store (`ios/README.md` → Storage, `relay/README.md` → What the relay can and can't see), and update its date when it changes.
