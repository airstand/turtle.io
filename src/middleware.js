const path = require("path");
const utility = require(path.join(__dirname, "utility.js"));
const regex = require(path.join(__dirname, "regex.js"));
const messages = require(path.join(__dirname, "messages.js"));
const codes = require(path.join(__dirname, "codes.js"));

function connect (req, res, next) {
	let server = req.server,
		payload;

	if (regex.body.test(req.method)) {
		req.setEncoding("utf-8");

		req.on("data", data => {
			payload = payload === undefined ? data : payload + data;

			if (server.config.maxBytes > 0 && Buffer.byteLength(payload) > server.config.maxBytes) {
				req.invalid = true;
				next(new Error(server.codes.REQ_TOO_LARGE));
			}
		});

		req.on("end", function () {
			if (!req.invalid) {
				if (payload) {
					req.body = payload;
				}

				next();
			}
		});
	} else {
		next();
	}
}

function cors (req, res, next) {
	req.cors = req.headers.origin !== undefined;
	next();
}

function headers (req, res, next) {
		let timer = precise().start(),
			rHeaders = utility.clone(lRHeaders),
			lheaders;

		// Decorating response headers
		if (status !== this.codes.NOT_MODIFIED && status >= this.codes.MULTIPLE_CHOICE && status < this.codes.BAD_REQUEST) {
			lheaders = rHeaders;
		} else {
			lheaders = utility.merge(utility.clone(this.config.headers), rHeaders);

			if (!lheaders.allow) {
				lheaders.allow = req.allow;
			}

			if (!lheaders.date) {
				lheaders.date = new Date().toUTCString();
			}

			if (req.cors) {
				lheaders["access-control-allow-origin"] = req.headers.origin || req.headers.referer.replace(/\/$/, "");
				lheaders["access-control-allow-credentials"] = "true";
				lheaders["access-control-allow-methods"] = lheaders.allow;
			} else {
				delete lheaders["access-control-allow-origin"];
				delete lheaders["access-control-expose-headers"];
				delete lheaders["access-control-max-age"];
				delete lheaders["access-control-allow-credentials"];
				delete lheaders["access-control-allow-methods"];
				delete lheaders["access-control-allow-headers"];
			}

			// Decorating "Transfer-Encoding" header
			if (!lheaders["transfer-encoding"]) {
				lheaders["transfer-encoding"] = "identity";
			}

			// Removing headers not wanted in the response
			if (!regex.get.test(req.method) || status >= this.codes.BAD_REQUEST || lheaders["x-ratelimit-limit"]) {
				delete lheaders["cache-control"];
				delete lheaders.etag;
				delete lheaders["last-modified"];
			}

			if (lheaders["x-ratelimit-limit"]) {
				lheaders["cache-control"] = "no-cache";
			}

			if (status === this.codes.NOT_MODIFIED) {
				delete lheaders["last-modified"];
			}

			if (status === this.codes.NOT_FOUND && lheaders.allow) {
				delete lheaders["accept-ranges"];
			}

			if (status >= this.codes.SERVER_ERROR) {
				delete lheaders["accept-ranges"];
			}

			if (!lheaders["last-modified"]) {
				delete lheaders["last-modified"];
			}
		}

		lheaders.status = status + " " + (http.STATUS_CODES[status] || "");

		timer.stop();
		this.signal("headers", function () {
			return [status, timer.diff()];
		});

		return lheaders;
}

function etag (req, res, next) {
	let cached, headers;

	if (regex.get_only.test(req.method) && !req.headers.range && req.headers["if-none-match"] !== undefined) {
		// Not mutating cache, because `respond()` will do it
		cached = req.server.etags.cache[req.parsed.href];

		// Sending a 304 if Client is making a GET & has current representation
		if (cached && (req.headers["if-none-match"] || "").replace(/\"/g, "") === cached.value.etag) {
			headers = utility.clone(cached.value.headers);
			headers.age = parseInt(new Date().getTime() / 1000 - cached.value.timestamp, 10);
			res.respond(messages.NO_CONTENT, codes.NOT_MODIFIED, headers).then(null, function (e) {
				next(e);
			});
		} else {
			next();
		}
	} else {
		next();
	}
}

module.exports = {
	connect: connect,
	cors: cors,
	etag: etag
};
