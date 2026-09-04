# Official announcements

Edit `official-announcements.json` on the default GitHub branch to publish an official message without creating a Release.

```json
{
  "announcements": [
    {
      "id": "maintenance-2026-09-03",
      "title": "Maintenance window",
      "body": "Service will be unavailable for **15 minutes**.",
      "kind": "warning",
      "presentation": "modal"
    }
  ]
}
```

`id` must remain stable, use letters, digits, dots, underscores, or hyphens, and be at most 128 characters. `kind` is `info`, `notice`, or `warning`; `presentation` is `inbox` or `modal`. The Worker validates entries and uses the id to deliver each announcement once to every super administrator.
