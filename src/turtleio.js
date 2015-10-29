const array = require("retsu"),
	constants = require("constants"),
	csv = require("csv.js"),
	defer = require("tiny-defer"),
	dtrace = require("dtrace-provider"),
	fs = require("fs"),
	http = require("http"),
	https = require("https"),
	mime = require("mime"),
	mmh3 = require("murmurhash3js").x86.hash32,
	moment = require("moment"),
	os = require("os"),
	path = require("path"),
	precise = require("precise"),
	lru = require("tiny-lru"),
	zlib = require("zlib"),
	levels = require(path.join(__dirname, "levels.js")),
	regex = require(path.join(__dirname, "regex.js")),
	router = require(path.join(__dirname, "router.js")),
	utility = require(path.join(__dirname, "utility.js")),
	version = require(path.join(__dirname, "..", "package.json")).version,
	defaultConfig = require(path.join(__dirname, "..", "config.json")),
	all = "all",
	verbs = ["DELETE","GET", "POST", "PUT", "PATCH"];

class TurtleIO {
	constructor () {
		this.config = utility.clone(defaultConfig);
		this.dtp = null;
		this.etags = lru(defaultConfig.cache);
		this.levels = levels;
		this.messages = messages;
		this.middleware = haro(null, {id: "routes", versioning: false, index: ["host", "method", "uri"]});
		this.middleware = {all: {}};
		this.loglevel = "";
		this.logging = false;
		this.permissions = lru(defaultConfig.cache);
		this.routeCache = lru(defaultConfig.cache * verbs.length);
		this.pages = {all: {}};
		this.server = null;
		this.vhosts = [];
		this.vhostsRegExp = [];
		this.watching = {};
	}

	/**
	 * Adds a function the middleware 'no action' hash
	 *
	 * @method blacklist
	 * @param  {Function} fn Function to add
	 * @return {Object}      TurtleIO instance
	 */
	blacklist (fn) {
		let hfn = fn.hash || this.hash(fn.toString());

		if (this.config.noaction === undefined) {
			this.config.noaction = {};
		}

		if (!this.config.noaction[hfn]) {
			this.config.noaction[hfn] = 1;
		}

		return this;
	}

	/**
	 * Decorates the Request & Response
	 *
	 * @method decorate
	 * @param  {Object} req Request Object
	 * @param  {Object} res Response Object
	 * @return {Undefined}  Undefined
	 */
	decorate (req, res) {
		let timer = precise().start(), // Assigning as early as possible
			uri = this.url(req),
			parsed = utility.parse(uri),
			hostname = parsed.hostname,
			update = false;

		// Decorating parsed Object on request
		req.body = "";
		res.header = res.setHeader;
		req.ip = req.headers["x-forwarded-for"] ? array.last(utility.explode(req.headers["x-forwarded-for"])) : req.connection.remoteAddress;
		res.locals = {};
		req.parsed = parsed;
		req.query = parsed.query;
		req.server = this;
		req.timer = timer;

		// Finding a matching virtual host
		this.vhostsRegExp.forEach((i, idx) => {
			if (i.test(hostname)) {
				return !(req.vhost = this.vhosts[idx]);
			}
		});

		req.vhost = req.vhost || this.config.default;

		// Adding middleware to avoid the round trip next time
		if (!this.allowed("get", req.parsed.pathname, req.vhost)) {
			this.get(req.parsed.pathname, (req2, res2, next2) => {
				this.request(req2, res2).then(function () {
					next2();
				}, function (e) {
					next2(e);
				});
			}, req.vhost);

			update = true;
		}

		req.allow = this.allows(req.parsed.pathname, req.vhost, update);

		// Adding methods
		res.redirect = target => {
			return this.respond.call(this, req, res, this.messages.NO_CONTENT, this.codes.FOUND, {location: target});
		};

		res.respond = (arg, status, headers) => {
			return this.respond.call(this, req, res, arg, status, headers);
		};

		res.error = (status, arg) => {
			return this.error.call(this, req, res, status, arg);
		};

		res.send = (arg, status, headers) => {
			return this.respond.call(this, req, res, arg, status, headers);
		};
	}

	/**
	 * Constructs a URL
	 *
	 * @method url
	 * @param  {Object} req Request Object
	 * @return {String}     Requested URL
	 */
	url (req) {
		let header = req.headers.authorization || "",
			auth = "",
			token;

		if (!utility.isEmpty(header)) {
			token = header.split(regex.space).pop() || "";
			auth = new Buffer(token, "base64").toString();

			if (!utility.isEmpty(auth)) {
				auth += "@";
			}
		}

		return "http" + (this.config.ssl.cert ? "s" : "") + "://" + auth + req.headers.host + req.url;
	}

	/**
	 * Adds middleware to processing chain
	 *
	 * @method use
	 * @param  {String}   rpath   [Optional] Path the middleware applies to, default is `/*`
	 * @param  {Function} fn      Middlware to chain
	 * @param  {String}   host    [Optional] Host
	 * @param  {String}   method  [Optional] HTTP method
	 * @return {Object}           TurtleIO instance
	 */
	use (rpath, fn, host, method) {
		let lpath = rpath,
			lfn = fn,
			lhost = host,
			lmethod = method;

		if (typeof lpath !== "string") {
			lhost = lfn;
			lfn = lpath;
			lpath = "/.*";
		}

		lhost = lhost || all;
		lmethod = lmethod || all;

		if (typeof lfn !== "function" && (lfn && typeof lfn.handle !== "function")) {
			throw new Error("Invalid middleware");
		}

		if (!this.middleware[lhost]) {
			this.middleware[lhost] = {};
		}

		if (!this.middleware[lhost][lmethod]) {
			this.middleware[lhost][lmethod] = {};
		}

		if (!this.middleware[lhost][lmethod][lpath]) {
			this.middleware[lhost][lmethod][lpath] = [];
		}

		if (lfn.handle) {
			lfn = lfn.handle;
		}

		lfn.hash = this.hash(lfn.toString());
		this.middleware[lhost][lmethod][lpath].push(lfn);

		return this;
	}
}

module.exports = TurtleIO;
