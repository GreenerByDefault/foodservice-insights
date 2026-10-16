# Runbooks

## Context

Some operations are done by hand in a vendor's dashboard, and nothing in the code records how. This
plan collects them until we decide where runbooks belong. **Open:** where that is (a `docs/`
folder, beside the config each one touches, or somewhere outside the repo) and what format they
take. When it's settled, move each entry below to its new home and delete this plan.

## Entries

### Rotate the DigitalOcean deploy token

CI deploys with `DIGITALOCEAN_ACCESS_TOKEN`, a secret in the `production` GitHub Environment. The
token belongs to whoever created it, so it stops working when it expires or when that person
leaves the DigitalOcean team.

1. In the DigitalOcean dashboard, switch to the nonprofit's team. A token only works within the
   team it was created in.
2. Go to **API → Personal access tokens → Generate New Token**.
3. Give it a name, and a fixed expiration rather than none. Set a calendar reminder to rotate it
   before it expires.
4. Choose **Custom Scopes** and select `app:read`, `app:update`, `regions:read`, `sizes:read`, and
   `actions:read`. DigitalOcean requires the last three alongside `app:update`
   ([docs](https://docs.digitalocean.com/reference/api/scopes/app/update/)). Leave off the
   optional associated scopes, along with `app:create` and `app:delete`: CI only updates apps that
   already exist. `doctl apps update --wait` updates the app, polls the deployment, and reads the
   app, and nothing more.
5. Click **Generate Token** and copy it. DigitalOcean shows it only once.
6. Store it from the repo, which prompts for the value so it stays out of shell history:

   ```sh
   gh secret set DIGITALOCEAN_ACCESS_TOKEN --env production
   ```

7. Check that it works by reading an app with it. The app IDs are the Environment's
   `DO_WEB_APP_ID` and `DO_WORKER_APP_ID`:

   ```sh
   read -s "DO_TOKEN?Paste the DigitalOcean token, then press Enter: "; echo
   curl -s -H "Authorization: Bearer $DO_TOKEN" \
     "https://api.digitalocean.com/v2/apps/<app id>" | jq '.app | {id, default_ingress} // .'
   unset DO_TOKEN
   ```

8. Delete the old token in the dashboard.
