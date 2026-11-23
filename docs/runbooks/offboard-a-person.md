# Offboard a person

When someone who worked on the app leaves, whether GBD staff or a contractor. Work in this order:
the first step breaks deploys if it comes after the others.

1. **If they created `DIGITALOCEAN_ACCESS_TOKEN`, rotate it first**, under a GBD staff login
   ([Rotate a secret](rotate-a-secret.md) § `DIGITALOCEAN_ACCESS_TOKEN`). Their token stops
   working the moment they leave GBD's DigitalOcean team, and the next deploy fails after it has
   migrated.
2. **Rotate every other secret they hold a copy of.** Whoever minted a secret saw it, so
   offboarding whoever set up production means rotating them all. If they had the `cache_client`
   string, rotate it too ([Rotate a secret](rotate-a-secret.md) § The `cache_client` password).
3. **Remove them from every vendor** in the [README's table](README.md#where-things-are), GitHub
   included.
4. **If they are a superadmin in the app,** set their `app_user.is_superadmin` back to false, as
   [Write to the database by hand](write-to-the-database-by-hand.md) shows.

API keys for the lab's other LLMs are their own, so GBD has nothing to revoke there.

To onboard someone, add them to the vendors they need, and hand them the `cache_client` string if
they will run the worker `live` or use the lab.
