self.addEventListener("install", event => {
    console.log("NEXORA Service Worker installé.");
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    console.log("NEXORA Service Worker activé.");
    event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {

    let data = {};

    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = {
            title: "NEXORA",
            body: event.data ? event.data.text() : "Nouvelle notification"
        };
    }

    const title = data.title || "NEXORA";

    const options = {
        body: data.body || "Vous avez une nouvelle notification.",
        icon: data.icon || "/icon-192.png",
        badge: data.badge || "/icon-192.png",
        data: {
            url: data.url || "/"
        }
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener("notificationclick", event => {

    event.notification.close();

    const url =
        event.notification.data &&
        event.notification.data.url
            ? event.notification.data.url
            : "/";

    event.waitUntil(
        clients.matchAll({
            type: "window",
            includeUncontrolled: true
        }).then(clientList => {

            for (const client of clientList) {

                if ("focus" in client) {
                    client.navigate(url);
                    return client.focus();
                }
            }

            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});
