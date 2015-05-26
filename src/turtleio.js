/**
 * TurtleIO
 *
 * @type {Object}
 */
class TurtleIO {
	constructor () {
		this.config = {};
		this.codes = CODES;
		this.dtp = null;
		this.etags = lru( 1000 );
		this.levels = LEVELS;
		this.messages = MESSAGES;
		this.middleware = { all: {} };
		this.permissions = lru( 1000 );
		this.routeCache = lru( 5000 ); // verbs * etags
		this.pages = { all: {} };
		this.server = null;
		this.vhosts = [];
		this.vhostsRegExp = [];
		this.watching = {};
	}

	/**
	 * Verifies a method is allowed on a URI
	 *
	 * @method allowed
	 * @param  {String}  method   HTTP verb
	 * @param  {String}  uri      URI to query
	 * @param  {String}  host     Hostname
	 * @param  {Boolean} override Overrides cached version
	 * @return {Boolean}          Boolean indicating if method is allowed
	 */
	allowed ( method, uri, host, override ) {
		let timer = precise().start();
		let result = this.routes( uri, host, method, override ).filter( i => {
			return this.config.noaction[ i.hash || this.hash( i ) ] === undefined;
		} );

		timer.stop();
		this.signal( "allowed", function () {
			return [ host, uri, method.toUpperCase(), timer.diff() ];
		} );

		return result.length > 0;
	}

	/**
	 * Determines which verbs are allowed against a URL
	 *
	 * @method allows
	 * @param  {String}  uri      URI to query
	 * @param  {String}  host     Hostname
	 * @param  {Boolean} override Overrides cached version
	 * @return {String}           Allowed methods
	 */
	allows ( uri, host, override ) {
		let timer = precise().start(),
			result = !override ? this.permissions.get( host + "_" + uri ) : undefined;

		if ( override || !result ) {
			result = VERBS.filter( i => {
				return this.allowed( i, uri, host, override );
			} );

			result = result.join( ", " ).toUpperCase().replace( "GET", "GET, HEAD, OPTIONS" );
			this.permissions.set( host + "_" + uri, result );
		}

		timer.stop();
		this.signal( "allows", function () {
			return [ host, uri, timer.diff() ];
		} );

		return result;
	}

	/**
	 * Adds a function the middleware 'no action' hash
	 *
	 * @method blacklist
	 * @param  {Function} fn Function to add
	 * @return {Object}      TurtleIO instance
	 */
	blacklist ( fn ) {
		let hfn = fn.hash || this.hash( fn.toString() );

		if ( this.config.noaction === undefined ) {
			this.config.noaction = {};
		}

		if ( !this.config.noaction[ hfn ] ) {
			this.config.noaction[ hfn ] = 1;
		}

		return this;
	}

	/**
	 * Connection handler
	 *
	 * @method connect
	 * @param  {Array} args [req, res]
	 * @return {Object}     Promise
	 */
	connect ( args ) {
		let deferred = defer(),
			req = args[ 0 ],
			res = args[ 1 ],
			method = req.method.toLowerCase(),
			payload;

		// Setting listeners if expecting a body
		if ( regex.body.test( method ) ) {
			req.setEncoding( "utf-8" );

			req.on( "data", data => {
				payload = payload === undefined ? data : payload + data;

				if ( this.config.maxBytes > 0 && Buffer.byteLength( payload ) > this.config.maxBytes ) {
					req.invalid = true;
					deferred.reject( new Error( this.codes.REQ_TOO_LARGE ) );
				}
			} );

			req.on( "end", function () {
				if ( !req.invalid ) {
					if ( payload ) {
						req.body = payload;
					}

					deferred.resolve( [ req, res ] );
				}
			} );
		} else {
			deferred.resolve( [ req, res ] );
		}

		return deferred.promise;
	}

	/**
	 * Pipes compressed asset to Client
	 *
	 * @method compressed
	 * @param  {Object}  req     HTTP(S) request Object
	 * @param  {Object}  res     HTTP(S) response Object
	 * @param  {Object}  body    Response body
	 * @param  {Object}  type    gzip (gz) or deflate (df)
	 * @param  {String}  etag    Etag
	 * @param  {Boolean} file    Indicates `body` is a file path
	 * @param  {Object}  options Stream options
	 * @param  {Number}  status  HTTP status
	 * @param  {Object}  headers HTTP headers
	 * @return {Object}          Promise
	 */
	compress ( req, res, body, type, etag, file, options, status, headers ) {
		let timer = precise().start(),
			deferred = defer(),
			method = regex.gzip.test( type ) ? "createGzip" : "createDeflate",
			sMethod = method.replace( "create", "" ).toLowerCase(),
			fp = etag ? path.join( this.config.tmp, etag + "." + type ) : null;

		let next = exist => {
			if ( !file ) {
				if ( typeof body.pipe == "function" ) { // Pipe Stream through compression to Client & disk
					if ( !res._header && !res._headerSent ) {
						headers[ "transfer-encoding" ] = "chunked";
						delete headers["content-length"];
						res.writeHead( status, headers );
					}

					body.pipe( zlib[ method ]() ).on( "end", function () {
						deferred.resolve( true );
					} ).pipe( res );
					body.pipe( zlib[ method ]() ).pipe( fs.createWriteStream( fp ) );
					timer.stop();
					this.signal( "compress", function () {
						return [ etag, fp, timer.diff() ];
					} );
				} else { // Raw response body, compress and send to Client & disk
					zlib[ sMethod ]( body, ( e, data ) => {
						if ( e ) {
							this.unregister( req.parsed.href );
							deferred.reject( new Error( this.codes.SERVER_ERROR ) );
						} else {
							if ( !res._header && !res._headerSent ) {
								headers[ "content-length" ] = data.length;
								headers[ "transfer-encoding" ] = "identity";
								res.writeHead( status, headers );
							}

							res.end( data );

							if ( fp ) {
								fs.writeFile( fp, data, "utf8", ( e ) => {
									if ( e ) {
										this.unregister( req.parsed.href );
									}
								} );
							}

							timer.stop();
							this.signal( "compress", function () {
								return [ etag, fp || "dynamic", timer.diff() ];
							} );
							deferred.resolve( true );
						}
					} );
				}
			} else {
				if ( !res._header && !res._headerSent ) {
					headers[ "transfer-encoding" ] = "chunked";
					delete headers["content-length"];
					res.writeHead( status, headers );
				}

				// Pipe compressed asset to Client
				fs.createReadStream( body, options ).on( "error", () => {
					this.unregister( req.parsed.href );
					deferred.reject( new Error( this.codes.SERVER_ERROR ) );
				} ).pipe( zlib[ method ]() ).on( "close", function () {
					deferred.resolve( true );
				} ).pipe( res );

				// Pipe compressed asset to disk
				if ( exist === false ) {
					fs.createReadStream( body ).on( "error", () => {
						this.unregister( req.parsed.href );
					} ).pipe( zlib[ method ]() ).pipe( fs.createWriteStream( fp ) );
				}

				timer.stop();
				this.signal( "compress", function () {
					return [ etag, fp, timer.diff() ];
				} );
			}
		};

		if ( fp ) {
			fs.exists( fp, exist => {
				// Pipe compressed asset to Client
				if ( exist ) {
					fs.lstat( fp, ( e, stats ) => {
						if ( e ) {
							deferred.reject( new Error( this.codes.SERVER_ERROR ) );
						} else {
							if ( !res._header && !res._headerSent ) {
								headers[ "transfer-encoding" ] = "chunked";
								delete headers["content-length"];

								if ( options ) {
									headers[ "content-range" ] = "bytes " + options.start + "-" + options.end + "/" + stats.size;
								}

								res.writeHead( status, headers );
							}

							fs.createReadStream( fp, options ).on( "error", () => {
								this.unregister( req.parsed.href );
								deferred.reject( new Error( this.codes.SERVER_ERROR ) );
							} ).on( "close", function () {
								deferred.resolve( true );
							} ).pipe( res );
							timer.stop();
							this.signal( "compress", function () {
								return [ etag, fp, timer.diff() ];
							} );
						}
					} );
				} else {
					next( exist );
				}
			} );
		} else {
			next( false );
		}

		return deferred.promise;
	}

	/**
	 * Determines what/if compression is supported for a request
	 *
	 * @method compression
	 * @param  {String} agent    User-Agent header value
	 * @param  {String} encoding Accept-Encoding header value
	 * @param  {String} mimetype Mime type of response body
	 * @return {Mixed}           Supported compression or null
	 */
	compression ( agent, encoding, mimetype ) {
		let timer = precise().start(),
			result = null,
			encodings = typeof encoding == "string" ? string.explode( encoding ) : [];

		// No soup for IE!
		if ( this.config.compress === true && regex.comp.test( mimetype ) && !regex.ie.test( agent ) ) {
			// Iterating supported encodings
			array.each( encodings, function ( i ) {
				if ( regex.gzip.test( i ) ) {
					result = "gz";
				}

				if ( regex.def.test( i ) ) {
					result = "zz";
				}

				// Found a supported encoding
				if ( result !== null ) {
					return false;
				}
			} );
		}

		timer.stop();
		this.signal( "compression", function () {
			return [ agent, timer.diff() ];
		} );

		return result;
	}

	/**
	 * Decorates the Request & Response
	 *
	 * @method decorate
	 * @param  {Object} req Request Object
	 * @param  {Object} res Response Object
	 * @return {Object}     Promise
	 */
	decorate ( req, res ) {
		let timer = precise().start(), // Assigning as early as possible
			deferred = defer(),
			url = this.url( req ),
			parsed = parse( url ),
			hostname = parsed.hostname,
			update = false;

		// Decorating parsed Object on request
		req.body = "";
		res.header = res.setHeader;
		req.ip = req.headers[ "x-forwarded-for" ] ? array.last( string.explode( req.headers[ "x-forwarded-for" ] ) ) : req.connection.remoteAddress;
		res.locals = {};
		req.parsed = parsed;
		req.query = parsed.query;
		req.server = this;
		req.timer = timer;

		// Finding a matching virtual host
		array.each( this.vhostsRegExp, ( i, idx ) => {
			if ( i.test( hostname ) ) {
				return !( req.vhost = this.vhosts[ idx ] );
			}
		} );

		req.vhost = req.vhost || this.config[ "default" ];

		// Adding middleware to avoid the round trip next time
		if ( !this.allowed( "get", req.parsed.pathname, req.vhost ) ) {
			this.get( req.parsed.pathname, ( req, res, next ) => {
				this.request( req, res ).then( function () {
					next();
				}, function ( e ) {
					next( e );
				} );
			}, req.vhost );

			update = true;
		}

		req.allow = this.allows( req.parsed.pathname, req.vhost, update );

		// Adding methods
		res.redirect = uri => {
			this.respond( req, res, this.messages.NO_CONTENT, this.codes.FOUND, { location: uri } );
		};

		res.respond = ( arg, status, headers ) => {
			this.respond( req, res, arg, status, headers );
		};

		res.error = ( status, arg ) => {
			this.error( req, res, status, arg );
		};

		deferred.resolve( [ req, res ] );

		return deferred.promise;
	}

	/**
	 * Encodes `arg` as JSON if applicable
	 *
	 * @method encode
	 * @param  {Mixed}  arg    Object to encode
	 * @param  {String} accept Accept HTTP header
	 * @return {Mixed}         Original Object or JSON string
	 */
	encode ( arg, accept ) {
		let header, indent;

		if ( arg instanceof Buffer || typeof arg.pipe == "function" ) {
			return arg;
		} else if ( arg instanceof Array || arg instanceof Object ) {
			header = regex.indent.exec( accept );
			indent = header !== null ? parseInt( header[ 1 ], 10 ) : this.config.json;

			return JSON.stringify( arg, null, indent );
		} else {
			return arg;
		}
	}

	/**
	 * Error handler for requests
	 *
	 * @method error
	 * @param  {Object} req    Request Object
	 * @param  {Object} res    Response Object
	 * @param  {Number} status [Optional] HTTP status code
	 * @param  {String} msg    [Optional] Response body
	 * @return {Object}        Promise
	 */
	error ( req, res, status, msg ) {
		let timer = precise().start(),
			deferred = defer(),
			method = req.method.toLowerCase(),
			host = req.parsed ? req.parsed.hostname : ALL,
			kdx = -1,
			body;

		if ( isNaN( status ) ) {
			status = this.codes.NOT_FOUND;

			// If valid, determine what kind of error to respond with
			if ( !regex.get.test( method ) ) {
				if ( this.allowed( method, req.parsed.pathname, req.vhost ) ) {
					status = this.codes.SERVER_ERROR;
				} else {
					status = this.codes.NOT_ALLOWED;
				}
			}
		}

		array.each( array.cast( this.codes ), function ( i, idx ) {
			if ( i === status ) {
				kdx = idx;
				return false;
			}
		} );

		if ( msg === undefined ) {
			body = this.page( status, host );
		}

		timer.stop();
		this.signal( "error", () => {
			return [ req.vhost, req.parsed.path, status, msg || kdx ? array.cast( this.messages )[ kdx ] : "Unknown error", timer.diff() ];
		} );

		this.respond( req, res, msg || body, status, {
			"cache-control": "no-cache",
			"content-length": Buffer.byteLength( msg || body )
		} ).then( function () {
			deferred.resolve( true );
		}, function () {
			deferred.resolve( true );
		} );

		return deferred.promise;
	}

	/**
	 * Generates an Etag
	 *
	 * @method etag
	 * @return {String}          Etag value
	 */
	etag ( ...args ) {
		return this.hash( args.join( "-" ) );
	}

	/**
	 * Handles the request
	 *
	 * @method handle
	 * @param  {Object}  req   HTTP(S) request Object
	 * @param  {Object}  res   HTTP(S) response Object
	 * @param  {String}  path  File path
	 * @param  {String}  url   Requested URL
	 * @param  {Boolean} dir   `true` is `path` is a directory
	 * @param  {Object}  stat  fs.Stat Object
	 * @return {Object}        Promise
	 */
	handle ( req, res, path, url, dir, stat ) {
		let deferred = defer(),
			allow = req.allow,
			write = allow.indexOf( dir ? "POST" : "PUT" ) > -1,
			del = allow.indexOf( "DELETE" ) > -1,
			method = req.method,
			etag, headers, mimetype, modified, size, pathname, invalid, out_dir, in_dir;

		if ( !dir ) {
			pathname = req.parsed.pathname.replace( regex.root, "" );
			invalid = ( pathname.replace( regex.dir, "" ).split( "/" ).filter( function ( i ) {
					return i != ".";
				} )[ 0 ] || "" ) === "..";
			out_dir = !invalid ? ( pathname.match( /\.{2}\//g ) || [] ).length : 0;
			in_dir = !invalid ? ( pathname.match( /\w+?(\.\w+|\/)+/g ) || [] ).length : 0;

			// Are we still in the virtual host root?
			if ( invalid || ( out_dir > 0 && out_dir >= in_dir ) ) {
				deferred.reject( new Error( this.codes.NOT_FOUND ) );
			} else if ( regex.get.test( method ) ) {
				mimetype = mime.lookup( path );
				size = stat.size;
				modified = stat.mtime.toUTCString();
				etag = "\"" + this.etag( url, size, stat.mtime ) + "\"";
				headers = {
					allow: allow,
					"content-length": size,
					"content-type": mimetype,
					etag: etag,
					"last-modified": modified
				};

				if ( regex.get_only.test( method ) ) {
					// Decorating path for watcher
					req.path = path;

					// Client has current version
					if ( ( req.headers[ "if-none-match" ] === etag ) || ( !req.headers[ "if-none-match" ] && Date.parse( req.headers[ "if-modified-since" ] ) >= stat.mtime ) ) {
						this.respond( req, res, this.messages.NO_CONTENT, this.codes.NOT_MODIFIED, headers, true ).then( function ( arg ) {
							deferred.resolve( arg );
						}, function ( e ) {
							deferred.reject( e );
						} );
					} else {
						this.respond( req, res, path, this.codes.SUCCESS, headers, true ).then( function ( arg ) {
							deferred.resolve( arg );
						}, function ( e ) {
							deferred.reject( e );
						} );
					}
				} else {
					this.respond( req, res, this.messages.NO_CONTENT, this.codes.SUCCESS, headers, true ).then( function ( arg ) {
						deferred.resolve( arg );
					}, function ( e ) {
						deferred.reject( e );
					} );
				}
			} else if ( regex.del.test( method ) && del ) {
				this.unregister( this.url( req ) );

				fs.unlink( path, ( e ) => {
					if ( e ) {
						deferred.reject( new Error( this.codes.SERVER_ERROR ) );
					} else {
						this.respond( req, res, this.messages.NO_CONTENT, this.codes.NO_CONTENT, {} ).then( function ( arg ) {
							deferred.resolve( arg );
						}, function ( e ) {
							deferred.reject( e );
						} );
					}
				} );
			} else if ( regex.put.test( method ) && write ) {
				this.write( req, res, path ).then( function ( arg ) {
					deferred.resolve( arg );
				}, function ( e ) {
					deferred.reject( e );
				} );
			} else {
				deferred.reject( new Error( this.codes.SERVER_ERROR ) );
			}
		} else {
			if ( ( regex.post.test( method ) || regex.put.test( method ) ) && write ) {
				this.write( req, res, path ).then( function ( arg ) {
					deferred.resolve( arg );
				}, function ( e ) {
					deferred.reject( e );
				} );
			} else if ( regex.del.test( method ) && del ) {
				this.unregister( req.parsed.href );

				fs.unlink( path, e => {
					if ( e ) {
						deferred.reject( new Error( this.codes.SERVER_ERROR ) );
					} else {
						this.respond( req, res, this.messages.NO_CONTENT, this.codes.NO_CONTENT, {} ).then( function ( arg ) {
							deferred.resolve( arg );
						}, function ( e ) {
							deferred.reject( e );
						} );
					}
				} );
			} else {
				deferred.reject( new Error( this.codes.NOT_ALLOWED ) );
			}
		}

		return deferred.promise;
	}

	/**
	 * Creates a hash of arg
	 *
	 * @method hash
	 * @param  {Mixed}  arg String or Buffer
	 * @return {String} Hash of arg
	 */
	hash ( arg ) {
		return mmh3( arg, this.config.seed );
	}

	/**
	 * Sets response headers
	 *
	 * @method headers
	 * @param  {Object}  req      Request Object
	 * @param  {Object}  rHeaders Response headers
	 * @param  {Number}  status   HTTP status code, default is 200
	 * @return {Object}           Response headers
	 */
	headers ( req, rHeaders={}, status=CODES.SUCCESS ) {
		let timer = precise().start(),
			get = regex.get.test( req.method ),
			headers;

		// Decorating response headers
		if ( status !== this.codes.NOT_MODIFIED && status >= this.codes.MULTIPLE_CHOICE && status < this.codes.BAD_REQUEST ) {
			headers = rHeaders;
		} else {
			headers = clone( this.config.headers, true );
			merge( headers, rHeaders );
			headers.allow = req.allow;

			if ( !headers.date ) {
				headers.date = new Date().toUTCString();
			}

			if ( req.cors ) {
				headers[ "access-control-allow-origin" ] = req.headers.origin || req.headers.referer.replace( /\/$/, "" );
				headers[ "access-control-allow-credentials" ] = "true";
				headers[ "access-control-allow-methods" ] = headers.allow;
			} else {
				delete headers[ "access-control-allow-origin" ];
				delete headers[ "access-control-expose-headers" ];
				delete headers[ "access-control-max-age" ];
				delete headers[ "access-control-allow-credentials" ];
				delete headers[ "access-control-allow-methods" ];
				delete headers[ "access-control-allow-headers" ];
			}

			// Decorating "Transfer-Encoding" header
			if ( !headers[ "transfer-encoding" ] ) {
				headers[ "transfer-encoding" ] = "identity";
			}

			// Removing headers not wanted in the response
			if ( !get || status >= this.codes.BAD_REQUEST || headers["x-ratelimit-limit"] ) {
				delete headers[ "cache-control" ];
				delete headers.etag;
				delete headers[ "last-modified" ];
			}

			if ( headers[ "x-ratelimit-limit" ] ) {
				headers[ "cache-control" ] = "no-cache";
			}

			if ( status === this.codes.NOT_MODIFIED ) {
				delete headers[ "last-modified" ];
			}

			if ( ( status === this.codes.NOT_FOUND && headers.allow ) || status >= this.codes.SERVER_ERROR ) {
				delete headers[ "accept-ranges" ];
			}

			if ( !headers[ "last-modified" ] ) {
				delete headers[ "last-modified" ];
			}
		}

		headers.status = status + " " + http.STATUS_CODES[ status ];
		timer.stop();
		this.signal( "headers", function () {
			return [ status, timer.diff() ];
		} );

		return headers;
	}

	/**
	 * Registers a virtual host
	 *
	 * @method host
	 * @param  {String} arg Virtual host
	 * @return {Object}     TurtleIO instance
	 */
	host ( arg ) {
		if ( !array.contains( this.vhosts, arg ) ) {
			this.vhosts.push( arg );
			this.vhostsRegExp.push( new RegExp( "^" + arg.replace( /\*/g, ".*" ) + "$" ) );
		}

		return this;
	}

	/**
	 * Logs a message
	 *
	 * @method log
	 * @param  {Mixed}  arg   Error Object or String
	 * @param  {String} level [Optional] `level` must match a valid LogLevel - http://httpd.apache.org/docs/1.3/mod/core.html#loglevel, default is `notice`
	 * @return {Object}       TurtleIO instance
	 */
	log ( arg, level ) {
		let timer, e;

		if ( LOGGING ) {
			timer = precise().start();
			e = arg instanceof Error;
			level = level || "notice";

			if ( this.config.logs.stdout && this.levels.indexOf( level ) <= LOGLEVEL ) {
				if ( e ) {
					console.error( "[" + moment().format( this.config.logs.time ) + "] [" + level + "] " + ( arg.stack || arg.message || arg ) );
				} else {
					console.log( arg );
				}
			}

			timer.stop();
			this.signal( "log", () => {
				return [ level, this.config.logs.stdout, false, timer.diff() ];
			} );
		}

		return this;
	}

	/**
	 * Gets an HTTP status page
	 *
	 * @method page
	 * @param  {Number} code HTTP status code
	 * @param  {String} host Virtual hostname
	 * @return {String}      Response body
	 */
	page ( code, host ) {
		host = host !== undefined && this.pages[ host ] ? host : ALL;

		return this.pages[ host ][ code ] || this.pages[ host ][ "500" ] || this.pages.all[ "500" ];
	}

	/**
	 * Monadic pipeline for the request
	 *
	 * @method pipeline
	 * @param  {Object} req Request Object
	 * @param  {Object} res Response Object
	 * @return {Object}     Promise
	 */
	pipeline ( req, res ) {
		return this.decorate( req, res ).then( args => {
			return this.connect( args );
		} ).then( args => {
			return this.route( args );
		} );
	}

	/**
	 * Preparing log message
	 *
	 * @method prep
	 * @param  {Object} req     HTTP(S) request Object
	 * @param  {Object} res     HTTP(S) response Object
	 * @param  {Object} headers HTTP(S) response headers
	 * @return {String}         Log message
	 */
	prep ( req, res, headers ) {
		let msg = this.config.logs.format,
			user = req.parsed ? ( req.parsed.auth.split( ":" )[ 0 ] || "-" ) : "-";

		msg = msg.replace( "%v", req.headers.host )
			.replace( "%h", req.ip || "-" )
			.replace( "%l", "-" )
			.replace( "%u", user )
			.replace( "%t", ( "[" + moment().format( this.config.logs.time ) + "]" ) )
			.replace( "%r", req.method + " " + req.url + " HTTP/1.1" )
			.replace( "%>s", res.statusCode )
			.replace( "%b", headers[ "content-length" ] || "-" )
			.replace( "%{Referer}i", req.headers.referer || "-" )
			.replace( "%{User-agent}i", req.headers[ "user-agent" ] || "-" );

		return msg;
	}

	/**
	 * Registers dtrace probes
	 *
	 * @method probes
	 * @return {Object} TurtleIO instance
	 */
	probes () {
		this.dtp.addProbe( "allowed", "char *", "char *", "char *", "int" );
		this.dtp.addProbe( "allows", "char *", "char *", "int" );
		this.dtp.addProbe( "compress", "char *", "char *", "int" );
		this.dtp.addProbe( "compression", "char *", "int" );
		this.dtp.addProbe( "error", "char *", "char *", "int", "char *", "int" );
		this.dtp.addProbe( "headers", "int", "int" );
		this.dtp.addProbe( "log", "char *", "int", "int", "int" );
		this.dtp.addProbe( "proxy", "char *", "char *", "char *", "char *", "int" );
		this.dtp.addProbe( "middleware", "char *", "char *", "int" );
		this.dtp.addProbe( "request", "char *", "int" );
		this.dtp.addProbe( "respond", "char *", "char *", "char *", "int", "int" );
		this.dtp.addProbe( "status", "int", "int", "int", "int", "int" );
		this.dtp.addProbe( "write", "char *", "char *", "char *", "char *", "int" );
		this.dtp.enable();
	}

	/**
	 * Proxies a URL to a route
	 *
	 * @method proxy
	 * @param  {String}  route  Route to proxy
	 * @param  {String}  origin Host to proxy (e.g. http://hostname)
	 * @param  {String}  host   [Optional] Hostname this route is for (default is all)
	 * @param  {Boolean} stream [Optional] Stream response to client (default is false)
	 * @return {Object}         TurtleIO instance
	 */
	proxy ( route, origin, host, stream=false ) {
		/**
		 * Response handler
		 *
		 * @method handle
		 * @private
		 * @param  {Object} req     Request Object
		 * @param  {Object} res     Response Object
		 * @param  {Object} headers Proxy Response headers
		 * @param  {Object} status  Proxy Response status
		 * @param  {String} arg     Proxy Response body
		 * @return {Undefined}      undefined
		 */
		let handle = ( req, res, headers, status, arg ) => {
			let deferred = defer(),
				etag = "",
				regexOrigin = new RegExp( origin.replace( regex.end_slash, "" ), "g" ),
				url = req.parsed.href,
				stale = STALE,
				get = regex.get_only.test( req.method ),
				rewriteOrigin = req.parsed.protocol + "//" + req.parsed.host + ( route == "/" ? "" : route ),
				cached, rewrite;

			if ( headers.server ) {
				headers.via = ( headers.via ? headers.via + ", " : "" ) + headers.server;
			}

			headers.server = this.config.headers.server;

			if ( status >= this.codes.BAD_REQUEST ) {
				this.error( req, res, status, arg ).then( function ( arg ) {
					deferred.resolve( arg );
				} );
			} else {
				// Determining if the response will be cached
				if ( get && ( status === this.codes.SUCCESS || status === this.codes.NOT_MODIFIED ) && !regex.nocache.test( headers[ "cache-control" ] ) && !regex[ "private" ].test( headers[ "cache-control" ] ) ) {
					// Determining how long rep is valid
					if ( headers[ "cache-control" ] && regex.number.test( headers[ "cache-control" ] ) ) {
						stale = number.parse( regex.number.exec( headers[ "cache-control" ] )[ 0 ], 10 );
					} else if ( headers.expires !== undefined ) {
						stale = new Date( headers.expires );
						stale = number.diff( stale, new Date() );
					}

					// Removing from LRU when invalid
					if ( stale > 0 ) {
						setTimeout( () => {
							this.unregister( url );
						}, stale * 1000 );
					}
				}

				if ( status !== this.codes.NOT_MODIFIED ) {
					rewrite = regex.rewrite.test( ( headers[ "content-type" ] || "" ).replace( regex.nval, "" ) );

					// Setting headers
					if ( get && status === this.codes.SUCCESS ) {
						etag = headers.etag || "\"" + this.etag( url, headers[ "content-length" ] || 0, headers[ "last-modified" ] || 0, this.encode( arg ) ) + "\"";

						if ( headers.etag !== etag ) {
							headers.etag = etag;
						}
					}

					if ( headers.allow === undefined || string.isEmpty( headers.allow ) ) {
						headers.allow = headers[ "access-control-allow-methods" ] || "GET";
					}

					// Determining if a 304 response is valid based on Etag only (no timestamp is kept)
					if ( get && req.headers[ "if-none-match" ] === etag ) {
						cached = this.etags.get( url );

						if ( cached ) {
							headers.age = parseInt( new Date().getTime() / 1000 - cached.value.timestamp, 10 );
						}

						this.respond( req, res, this.messages.NO_CONTENT, this.codes.NOT_MODIFIED, headers ).then( function ( arg ) {
							deferred.resolve( arg );
						}, function ( e ) {
							deferred.reject( e );
						} );
					} else {
						if ( regex.head.test( req.method.toLowerCase() ) ) {
							arg = this.messages.NO_CONTENT;
						} else if ( rewrite ) {
							// Changing the size of the response body
							delete headers[ "content-length" ];

							if ( arg instanceof Array || arg instanceof Object ) {
								arg = json.encode( arg, req.headers.accept ).replace( regexOrigin, rewriteOrigin );

								if ( route !== "/" ) {
									arg = arg.replace( /"(\/[^?\/]\w+)\//g, "\"" + route + "$1/" );
								}

								arg = json.decode( arg );
							} else if ( typeof arg == "string" ) {
								arg = arg.replace( regexOrigin, rewriteOrigin );

								if ( route !== "/" ) {
									arg = arg.replace( /(href|src)=("|')([^http|mailto|<|_|\s|\/\/].*?)("|')/g, ( "$1=$2" + route + "/$3$4" ) )
										.replace( new RegExp( route + "//", "g" ), route + "/" );
								}
							}
						}

						this.respond( req, res, arg, status, headers ).then( function ( arg ) {
							deferred.resolve( arg );
						}, function ( e ) {
							deferred.reject( e );
						} );
					}
				} else {
					this.respond( req, res, arg, status, headers ).then( function ( arg ) {
						deferred.resolve( arg );
					}, function ( e ) {
						deferred.reject( e );
					} );
				}
			}

			return deferred.promise;
		};

		/**
		 * Wraps the proxy request
		 *
		 * @method wrapper
		 * @private
		 * @param  {Object} req HTTP(S) request Object
		 * @param  {Object} res HTTP(S) response Object
		 * @return {Undefined}  undefined
		 */
		let wrapper = ( req, res ) => {
			let timer = precise().start(),
				deferred = defer(),
				url = origin + ( route !== "/" ? req.url.replace( new RegExp( "^" + route ), "" ) : req.url ),
				headerz = clone( req.headers, true ),
				parsed = parse( url ),
				streamd = ( stream === true ),
				mimetype = mime.lookup( !regex.ext.test( parsed.pathname ) ? "index.htm" : parsed.pathname ),
				fn, options, proxyReq, next, obj;

			// Facade to handle()
			fn = ( headers, status, body ) => {
				timer.stop();
				this.signal( "proxy", function () {
					return [ req.vhost, req.method, route, origin, timer.diff() ];
				} );
				handle( req, res, headers, status, body ).then( function ( arg ) {
					deferred.resolve( arg );
				}, function ( e ) {
					deferred.reject( e );
				} );
			};

			// Streaming formats that do not need to be rewritten
			if ( !streamd && ( regex.ext.test( parsed.pathname ) && !regex.json.test( mimetype ) ) && regex.stream.test( mimetype ) ) {
				streamd = true;
			}

			// Identifying proxy behavior
			headerz[ "x-host" ] = parsed.host;
			headerz[ "x-forwarded-for" ] = headerz[ "x-forwarded-for" ] ? headerz[ "x-forwarded-for" ] + ", " + req.ip : req.ip;
			headerz[ "x-forwarded-proto" ] = parsed.protocol.replace( ":", "" );
			headerz[ "x-forwarded-server" ] = this.config.headers.server;

			if ( !headerz[ "x-real-ip" ] ) {
				headerz[ "x-real-ip" ] = req.ip;
			}

			headerz.host = req.headers.host;
			options = {
				headers: headerz,
				hostname: parsed.hostname,
				method: req.method,
				path: parsed.path,
				port: parsed.port || headerz[ "x-forwarded-proto" ] === "https" ? 443 : 80,
				agent: false
			};

			if ( !string.isEmpty( parsed.auth ) ) {
				options.auth = parsed.auth;
			}

			if ( streamd ) {
				next = function ( proxyRes ) {
					res.writeHeader( proxyRes.statusCode, proxyRes.headers );
					proxyRes.pipe( res );
				};
			} else {
				next = function ( proxyRes ) {
					var data = "";

					proxyRes.setEncoding( "utf8" );
					proxyRes.on( "data", function ( chunk ) {
						data += chunk;
					} ).on( "end", function () {
						fn( proxyRes.headers, proxyRes.statusCode, data );
					} );
				}
			}

			if ( parsed.protocol.indexOf( "https" ) > -1 ) {
				options.rejectUnauthorized = false;
				obj = https;
			} else {
				obj = http;
			}

			proxyReq = obj.request( options, next );
			proxyReq.on( "error", e => {
				this.error( req, res, this.codes[ regex.refused.test( e.message ) ? "SERVER_UNAVAILABLE" : "SERVER_ERROR" ], e.message );
			} );

			if ( regex.body.test( req.method ) ) {
				proxyReq.write( req.body );
			}

			proxyReq.end();

			return deferred.promise;
		};

		// Setting route
		array.each( VERBS, ( i ) => {
			if ( route === "/" ) {
				this[ i ]( "/.*", wrapper, host );
			} else {
				this[ i ]( route, wrapper, host );
				this[ i ]( route + "/.*", wrapper, host );
			}
		} );

		return this;
	}

	/**
	 * Redirects GETs for a route to another URL
	 *
	 * @method redirect
	 * @param  {String}  route     Route to redirect
	 * @param  {String}  url       URL to redirect the Client to
	 * @param  {String}  host      [Optional] Hostname this route is for (default is all)
	 * @param  {Boolean} permanent [Optional] `true` will indicate the redirection is permanent
	 * @return {Object}            instance
	 */
	redirect ( route, url, host, permanent=false ) {
		let pattern = new RegExp( "^" + route + "$" );

		this.get( route, ( req, res ) => {
			let rewrite = ( pattern.exec( req.url ) || [] ).length > 0;

			this.respond( req, res, this.messages.NO_CONTENT, this.codes[ permanent ? "MOVED" : "REDIRECT" ], {
				location: rewrite ? req.url.replace( pattern, url ) : url,
				"cache-control": "no-cache"
			} );
		}, host );

		return this;
	}

	/**
	 * Registers an Etag in the LRU cache
	 *
	 * @method register
	 * @param  {String}  url   URL requested
	 * @param  {Object}  state Object describing state `{etag: $etag, mimetype: $mimetype}`
	 * @param  {Boolean} stale [Optional] Remove cache from disk
	 * @return {Object}        TurtleIO instance
	 */
	register ( url, state, stale ) {
		let cached;

		// Removing stale cache from disk
		if ( stale === true ) {
			cached = this.etags.cache[ url ];

			if ( cached && cached.value.etag !== state.etag ) {
				this.unregister( url );
			}
		}

		// Removing superficial headers
		array.each( [
			"content-encoding",
			"server",
			"status",
			"transfer-encoding",
			"x-powered-by",
			"x-response-time",
			"access-control-allow-origin",
			"access-control-expose-headers",
			"access-control-max-age",
			"access-control-allow-credentials",
			"access-control-allow-methods",
			"access-control-allow-headers"
		], function ( i ) {
			delete state.headers[ i ];
		} );

		// Updating LRU
		this.etags.set( url, state );

		return this;
	}

	/**
	 * Request handler which provides RESTful CRUD operations
	 *
	 * @method request
	 * @public
	 * @param  {Object} req HTTP(S) request Object
	 * @param  {Object} res HTTP(S) response Object
	 * @return {Object}     TurtleIO instance
	 */
	request ( req, res ) {
		let timer = precise().start(),
			deferred = defer(),
			method = req.method,
			handled = false,
			host = req.vhost,
			count, lpath, nth, root;

		let end = () => {
			timer.stop();
			this.signal( "request", function () {
				return [ req.parsed.href, timer.diff() ];
			} );
		};

		// If an expectation can't be met, don't try!
		if ( req.headers.expect ) {
			end();
			deferred.reject( new Error( this.codes.EXPECTATION_FAILED ) );
		}

		// Preparing file path
		root = path.join( this.config.root, this.config.vhosts[ host ] );
		lpath = path.join( root, req.parsed.pathname.replace( regex.dir, "" ) );

		// Determining if the request is valid
		fs.lstat( lpath, ( e, stats ) => {
			if ( e ) {
				end();
				deferred.reject( new Error( this.codes.NOT_FOUND ) );
			} else if ( !stats.isDirectory() ) {
				end();
				this.handle( req, res, lpath, req.parsed.href, false, stats ).then( function ( arg ) {
					deferred.resolve( arg );
				}, function ( e ) {
					deferred.reject( e );
				} );
			} else if ( regex.get.test( method ) && !regex.dir.test( req.parsed.pathname ) ) {
				end();
				this.respond( req, res, this.messages.NO_CONTENT, this.codes.REDIRECT, { "location": ( req.parsed.pathname != "/" ? req.parsed.pathname : "" ) + "/" + req.parsed.search } ).then( function ( arg ) {
					deferred.resolve( arg );
				}, function ( e ) {
					deferred.reject( e );
				} );
			} else if ( !regex.get.test( method ) ) {
				end();
				this.handle( req, res, lpath, req.parsed.href, true ).then( function ( arg ) {
					deferred.resolve( arg );
				}, function ( e ) {
					deferred.reject( e );
				} );
			} else {
				count = 0;
				nth = this.config.index.length;

				array.each( this.config.index, ( i ) => {
					let npath = path.join( lpath, i );

					fs.lstat( npath, ( e, stats ) => {
						if ( !e && !handled ) {
							handled = true;
							end();
							this.handle( req, res, npath, ( req.parsed.pathname != "/" ? req.parsed.pathname : "" ) + "/" + i + req.parsed.search, false, stats ).then( function ( arg ) {
								deferred.resolve( arg );
							}, function ( e ) {
								deferred.reject( e );
							} );
						} else if ( ++count === nth && !handled ) {
							end();
							deferred.reject( new Error( this.codes.NOT_FOUND ) );
						}
					} );
				} );
			}
		} );

		return deferred.promise;
	}

	/**
	 * Send a response
	 *
	 * @method respond
	 * @param  {Object}  req     Request Object
	 * @param  {Object}  res     Response Object
	 * @param  {Mixed}   body    Primitive, Buffer or Stream
	 * @param  {Number}  status  [Optional] HTTP status, default is `200`
	 * @param  {Object}  headers [Optional] HTTP headers
	 * @param  {Boolean} file    [Optional] Indicates `body` is a file path
	 * @return {Object}          TurtleIO instance
	 */
	respond ( req, res, body, status=CODES.SUCCESS, headers={ "content-type": "text/plain" }, file=false ) {
		let timer = precise().start(),
			deferred = defer(),
			head = regex.head.test( req.method ),
			ua = req.headers[ "user-agent" ],
			encoding = req.headers[ "accept-encoding" ],
			type, options;

		let finalize = () => {
			let cheaders, cached;

			if ( regex.get_only.test( req.method ) && ( status === this.codes.SUCCESS || status === this.codes.NOT_MODIFIED ) ) {
				// Updating cache
				if ( !regex.nocache.test( headers[ "cache-control" ] ) && !regex[ "private" ].test( headers[ "cache-control" ] ) ) {
					cached = this.etags.get( req.parsed.href );

					if ( !cached ) {
						if ( headers.etag === undefined ) {
							headers.etag = "\"" + this.etag( req.parsed.href, body.length || 0, headers[ "last-modified" ] || 0, body || 0 ) + "\"";
						}

						cheaders = clone( headers, true );

						// Ensuring the content type is known
						if ( !cheaders[ "content-type" ] ) {
							cheaders[ "content-type" ] = mime.lookup( req.path || req.parsed.pathname );
						}

						this.register( req.parsed.href, {
							etag: cheaders.etag.replace( /"/g, "" ),
							headers: cheaders,
							mimetype: cheaders[ "content-type" ],
							timestamp: parseInt( new Date().getTime() / 1000, 10 )
						}, true );
					}
				}

				// Setting a watcher on the local path
				if ( req.path ) {
					this.watch( req.parsed.href, req.path );
				}
			} else if ( status === this.codes.NOT_FOUND ) {
				delete headers.allow;
				delete headers[ "access-control-allow-methods" ];
			}
		};

		headers = this.headers( req, headers, status );

		if ( head ) {
			body = this.messages.NO_CONTENT;

			if ( regex.options.test( req.method ) ) {
				headers[ "content-length" ] = 0;
				delete headers[ "content-type" ];
			}

			delete headers.etag;
			delete headers[ "last-modified" ];
		} else if ( body === null || body === undefined ) {
			body = this.messages.NO_CONTENT;
		}

		if ( !file && body !== this.messages.NO_CONTENT ) {
			body = this.encode( body, req.headers.accept );

			if ( headers[ "content-length" ] === undefined ) {
				if ( body instanceof Buffer ) {
					headers[ "content-length" ] = Buffer.byteLength( body.toString() );
				}

				if ( typeof body == "string" ) {
					headers[ "content-length" ] = Buffer.byteLength( body );
				}
			}

			headers[ "content-length" ] = headers[ "content-length" ] || 0;

			// Ensuring JSON has proper mimetype
			if ( regex.json_wrap.test( body ) ) {
				headers[ "content-type" ] = "application/json";
			}

			// CSV hook
			if ( regex.get_only.test( req.method ) && status === this.codes.SUCCESS && body && headers[ "content-type" ] === "application/json" && req.headers.accept && regex.csv.test( string.explode( req.headers.accept )[ 0 ].replace( regex.nval, "" ) ) ) {
				headers[ "content-type" ] = "text/csv";

				if ( !headers[ "content-disposition" ] ) {
					headers[ "content-disposition" ] = "attachment; filename=\"" + req.parsed.pathname.replace( /.*\//g, "" ).replace( /\..*/, "_" ) + req.parsed.search.replace( "?", "" ).replace( /\&/, "_" ) + ".csv\"";
				}

				body = csv.encode( body );
			}
		}

		// Fixing 'accept-ranges' for non-filesystem based responses
		if ( !file ) {
			delete headers[ "accept-ranges" ];
		}

		if ( status === this.codes.NOT_MODIFIED ) {
			delete headers[ "accept-ranges" ];
			delete headers[ "content-encoding" ];
			delete headers[ "content-length" ];
			delete headers[ "content-type" ];
			delete headers.date;
			delete headers[ "transfer-encoding" ];
		}

		// Clean up, in case it these are still hanging around
		if ( status === this.codes.NOT_FOUND ) {
			delete headers.allow;
			delete headers[ "access-control-allow-methods" ];
		}

		// Setting `x-response-time`
		headers[ "x-response-time" ] = ( ( req.timer.stopped === null ? req.timer.stop() : req.timer ).diff() / 1000000 ).toFixed( 2 ) + " ms";

		// Setting the partial content headers
		if ( req.headers.range ) {
			options = {};
			array.each( req.headers.range.match( /\d+/g ) || [], ( i, idx ) => {
				options[ idx === 0 ? "start" : "end" ] = parseInt( i, 10 );
			} );

			if ( options.end === undefined ) {
				options.end = headers[ "content-length" ];
			}

			if ( isNaN( options.start ) || isNaN( options.end ) || options.start >= options.end ) {
				delete req.headers.range;
				return this.error( req, res, this.codes.NOT_SATISFIABLE ).then( function () {
					deferred.resolve( true );
				}, function ( e ) {
					deferred.reject( e );
				} );
			}

			status = this.codes.PARTIAL_CONTENT;
			headers.status = status + " " + http.STATUS_CODES[ status ];
			headers[ "content-range" ] = "bytes " + options.start + "-" + options.end + "/" + headers[ "content-length" ];
			headers[ "content-length" ] = number.diff( options.end, options.start ) + 1;
		}

		// Determining if response should be compressed
		if ( ua && ( status === this.codes.SUCCESS || status === this.codes.PARTIAL_CONTENT ) && body !== this.messages.NO_CONTENT && this.config.compress && ( type = this.compression( ua, encoding, headers[ "content-type" ] ) ) && type !== null ) {
			headers[ "content-encoding" ] = regex.gzip.test( type ) ? "gzip" : "deflate";

			if ( file ) {
				headers[ "transfer-encoding" ] = "chunked";
				delete headers["content-length"];
			}

			finalize();
			this.compress( req, res, body, type, headers.etag ? headers.etag.replace( /"/g, "" ) : undefined, file, options, status, headers ).then( function () {
				deferred.resolve( true );
			}, function ( e ) {
				deferred.reject( e );
			} );
		} else if ( ( status === this.codes.SUCCESS || status === this.codes.PARTIAL_CONTENT ) && file && regex.get_only.test( req.method ) ) {
			headers[ "transfer-encoding" ] = "chunked";
			delete headers["content-length"];
			finalize();

			if ( !res._header && !res._headerSent ) {
				res.writeHead( status, headers );
			}

			fs.createReadStream( body, options ).on( "error", () => {
				deferred.reject( new Error( this.codes.SERVER_ERROR ) );
			} ).on( "close", function () {
				deferred.resolve( true );
			} ).pipe( res );
		} else {
			finalize();

			if ( !res._header && !res._headerSent ) {
				res.writeHead( status, headers );
			}

			res.end( status === this.codes.PARTIAL_CONTENT ? body.slice( options.start, options.end ) : body );
			deferred.resolve( true );
		}

		timer.stop();
		this.signal( "respond", function () {
			return [ req.vhost, req.method, req.url, status, timer.diff() ];
		} );

		return deferred.promise;
	}

	/**
	 * Restarts the instance
	 *
	 * @method restart
	 * @return {Object} TurtleIO instance
	 */
	restart () {
		let config = this.config;

		return this.stop().start( config );
	}

	/**
	 * Runs middleware in a chain
	 *
	 * @method route
	 * @param  {Array} args [req, res]
	 * @return {Object}     Promise
	 */
	route ( args ) {
		let deferred = defer(),
			req = args[ 0 ],
			res = args[ 1 ],
			method = req.method.toLowerCase(),
			middleware;

		function get_arity ( arg ) {
			return arg.toString().replace( /(^.*\()|(\).*)|(\n.*)/g, "" ).split( "," ).length;
		}

		let last = ( err ) => {
			let error, status;

			if ( !err ) {
				if ( regex.get.test( method ) ) {
					deferred.resolve( args );
				} else if ( this.allowed( "get", req.parsed.pathname, req.vhost ) ) {
					deferred.reject( new Error( this.codes.NOT_ALLOWED ) );
				} else {
					deferred.reject( new Error( this.codes.NOT_FOUND ) );
				}
			} else {
				status = res.statusCode >= this.codes.BAD_REQUEST ? res.statusCode : ( !isNaN( err.message ) ? err.message : ( this.codes[ ( err.message || err ).toUpperCase() ] || this.codes.SERVER_ERROR ) );
				error = new Error( status );
				error.extended = isNaN( err.message ) ? err.message : undefined;

				deferred.reject( error );
			}
		};

		let next = err => {
			let arity = 3,
				item = middleware.next();

			if ( !item.done ) {
				if ( err ) {
					// Finding the next error handling middleware
					arity = get_arity( item.value );
					do {
						arity = get_arity( item.value );
					} while ( arity < 4 && ( item = middleware.next() ) && !item.done )
				}

				if ( !item.done ) {
					if ( err ) {
						if ( arity === 4 ) {
							try {
								item.value( err, req, res, next );
							} catch ( e ) {
								next( e );
							}
						} else {
							last( err );
						}
					} else {
						try {
							item.value( req, res, next );
						} catch ( e ) {
							next( e );
						}
					}
				} else {
					last( err );
				}
			} else if ( !res._header && this.config.catchAll ) {
				last( err );
			} else if ( res._header ) {
				deferred.resolve( args );
			}
		};

		if ( regex.head.test( method ) ) {
			method = "get";
		}

		middleware = array.iterator( this.routes( req.parsed.pathname, req.vhost, method ) );
		delay( next );

		return deferred.promise;
	}

	/**
	 * Returns middleware for the uri
	 *
	 * @method result
	 * @param  {String}  uri      URI to query
	 * @param  {String}  host     Hostname
	 * @param  {String}  method   HTTP verb
	 * @param  {Boolean} override Overrides cached version
	 * @return {Array}
	 */
	routes ( uri, host, method, override=false ) {
		let id = method + ":" + host + ":" + uri,
			cached = !override ? this.routeCache.get( id ) : undefined,
			all, h, result;

		if ( cached ) {
			return cached;
		}

		all = this.middleware.all || {};
		h = this.middleware[ host ] || {};
		result = [];

		array.each( [ all.all, all[ method ], h.all, h[ method ] ], function ( c ) {
			if ( c ) {
				array.each( array.keys( c ).filter( function ( i ) {
					return new RegExp( "^" + i + "$", "i" ).test( uri );
				} ), function ( i ) {
					result = result.concat( c[ i ] );
				} );
			}
		} );

		this.routeCache.set( id, result );

		return result;
	}

	/**
	 * Signals a probe
	 *
	 * @method signal
	 * @param  {String}   name Name of probe
	 * @param  {Function} fn   DTP handler
	 * @return {Object}        TurtleIO instance
	 */
	signal ( name, fn ) {
		if ( this.config.logs.dtrace ) {
			this.dtp.fire( name, fn );
		}

		return this;
	}

	/**
	 * Starts the instance
	 *
	 * @method start
	 * @param  {Object}   cfg Configuration
	 * @param  {Function} err Error handler
	 * @return {Object}       TurtleIO instance
	 */
	start ( cfg, err ) {
		let config, headers, pages;

		config = clone( defaultConfig, true );

		// Merging custom with default config
		merge( config, cfg || {} );

		this.dtp = dtrace.createDTraceProvider( config.id || "turtle-io" );

		// Duplicating headers for re-decoration
		headers = clone( config.headers, true );

		// Overriding default error handler
		if ( typeof err == "function" ) {
			this.error = err;
		}

		// Setting configuration
		if ( !config.port ) {
			config.port = 8000;
		}

		merge( this.config, config );

		// Setting temp folder
		this.config.tmp = this.config.tmp || os.tmpdir();

		pages = this.config.pages ? path.join( this.config.root, this.config.pages ) : path.join( __dirname, "../pages" );
		LOGLEVEL = this.levels.indexOf( this.config.logs.level );
		LOGGING = this.config.logs.dtrace || this.config.logs.stdout;

		// Looking for required setting
		if ( !this.config[ "default" ] ) {
			this.log( new Error( "[client 0.0.0.0] Invalid default virtual host" ), "error" );
			process.exit( 1 );
		}

		// Lowercasing default headers
		delete this.config.headers;
		this.config.headers = {};

		iterate( headers, ( value, key ) => {
			this.config.headers[ key.toLowerCase() ] = value;
		} );

		// Setting `Server` HTTP header
		if ( !this.config.headers.server ) {
			this.config.headers.server = "turtle.io/{{VERSION}}";
			this.config.headers[ "x-powered-by" ] = "node.js/" + process.versions.node.replace( /^v/, "" ) + " " + string.capitalize( process.platform ) + " V8/" + string.trim( process.versions.v8.toString() );
		}

		// Creating regex.rewrite
		regex.rewrite = new RegExp( "^(" + this.config.proxy.rewrite.join( "|" ) + ")$" );

		// Setting default routes
		this.host( ALL );

		// Registering DTrace probes
		this.probes();

		// Registering virtual hosts
		array.each( array.cast( config.vhosts, true ), ( i ) => {
			this.host( i );
		} );

		// Loading default error pages
		fs.readdir( pages, ( e, files ) => {
			if ( e ) {
				this.log( new Error( "[client 0.0.0.0] " + e.message ), "error" );
			} else if ( array.keys( this.config ).length > 0 ) {
				let next = ( req, res ) => {
					this.pipeline( req, res ).then( function ( arg ) {
						return arg;
					}, e => {
						let body, status;

						if ( isNaN( e.message ) ) {
							body = e;
							status = new Error( this.codes.SERVER_ERROR );
						} else {
							body = e.extended;
							status = e;
						}

						return this.error( req, res, status, body );
					} ).then( () => {
						this.log( this.prep( req, res, res._headers || {} ), "info" );
					} );
				};

				array.each( files, i => {
					this.pages.all[ i.replace( regex.next, "" ) ] = fs.readFileSync( path.join( pages, i ), "utf8" );
				} );

				// Starting server
				if ( this.server === null ) {
					if ( this.config.ssl.cert !== null && this.config.ssl.key !== null ) {
						// POODLE
						this.config.secureProtocol = "SSLv23_method";
						this.config.secureOptions = constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_SSLv2;

						// Reading files
						this.config.ssl.cert = fs.readFileSync( this.config.ssl.cert );
						this.config.ssl.key = fs.readFileSync( this.config.ssl.key );

						// Starting server
						this.server = https.createServer( merge( this.config.ssl, {
							port: this.config.port,
							host: this.config.address,
							secureProtocol: this.config.secureProtocol,
							secureOptions: this.config.secureOptions
						} ), next ).listen( this.config.port, this.config.address );
					} else {
						this.server = http.createServer( next ).listen( this.config.port, this.config.address );
					}
				} else {
					this.server.listen( this.config.port, this.config.address );
				}

				// Dropping process
				if ( this.config.uid && !isNaN( this.config.uid ) ) {
					process.setuid( this.config.uid );
				}

				this.log( "Started " + this.config.id + " on port " + this.config.port, "debug" );
			}
		} );

		// Something went wrong, server must restart
		process.on( "uncaughtException", e => {
			this.log( e, "error" );
			process.exit( 1 );
		} );

		return this;
	}

	/**
	 * Returns an Object describing the instance's status
	 *
	 * @method status
	 * @public
	 * @return {Object} Status
	 */
	status () {
		let timer = precise().start(),
			ram = process.memoryUsage(),
			uptime = process.uptime(),
			state = { config: {}, etags: {}, process: {}, server: {} },
			invalid = /^(auth|session|ssl)$/;

		// Startup parameters
		iterate( this.config, function ( v, k ) {
			if ( !invalid.test( k ) ) {
				state.config[ k ] = v;
			}
		} );

		// Process information
		state.process = {
			memory: ram,
			pid: process.pid
		};

		// Server information
		state.server = {
			address: this.server.address(),
			uptime: uptime
		};

		// LRU cache
		state.etags = {
			items: this.etags.length,
			bytes: Buffer.byteLength( array.cast( this.etags.cache ).map( function ( i ) {
				return i.value;
			} ).join( "" ) )
		};

		timer.stop();
		this.signal( "status", function () {
			return [ state.server.connections, uptime, ram.heapUsed, ram.heapTotal, timer.diff() ];
		} );

		return state;
	}

	/**
	 * Stops the instance
	 *
	 * @method stop
	 * @return {Object} TurtleIO instance
	 */
	stop () {
		let port = this.config.port;

		this.log( "Stopping " + this.config.id + " on port " + port, "debug" );
		this.config = {};
		this.dtp = null;
		this.etags = lru( 1000 );
		this.pages = { all: {} };
		this.permissions = lru( 1000 );
		this.routeCache = lru( 5000 ); // verbs * etags
		this.vhosts = [];
		this.vhostsRegExp = [];
		this.watching = {};

		if ( this.server !== null ) {
			this.server.close();
			this.server = null;
		}

		return this;
	}

	/**
	 * Unregisters an Etag in the LRU cache and removes stale representation from disk
	 *
	 * @method unregister
	 * @param  {String} url URL requested
	 * @return {Object}     TurtleIO instance
	 */
	unregister ( url ) {
		let cached = this.etags.cache[ url ],
			lpath = this.config.tmp,
			ext = [ "gz", "zz" ];

		if ( cached ) {
			lpath = path.join( lpath, cached.value.etag );
			this.etags.remove( url );
			array.each( ext, ( i ) => {
				let lfile = lpath + "." + i;

				fs.exists( lfile, ( exists ) => {
					if ( exists ) {
						fs.unlink( lfile, ( e ) => {
							if ( e ) {
								this.log( e );
							}
						} );
					}
				} );
			} );
		}

		return this;
	}

	/**
	 * Constructs a URL
	 *
	 * @method url
	 * @param  {Object} req Request Object
	 * @return {String}     Requested URL
	 */
	url ( req ) {
		let header = req.headers.authorization || "",
			auth = "",
			token;

		if ( !string.isEmpty( header ) ) {
			token = header.split( regex.space ).pop() || "";
			auth = new Buffer( token, "base64" ).toString();

			if ( !string.isEmpty( auth ) ) {
				auth += "@";
			}
		}

		return "http" + ( this.config.ssl.cert ? "s" : "" ) + "://" + auth + req.headers.host + req.url;
	}

	/**
	 * Adds middleware to processing chain
	 *
	 * @method use
	 * @param  {String}   path   [Optional] Path the middleware applies to, default is `/*`
	 * @param  {Function} fn     Middlware to chain
	 * @param  {String}   host   [Optional] Host
	 * @param  {String}   method [Optional] HTTP method
	 * @return {Object}          TurtleIO instance
	 */
	use ( path, fn, host, method ) {
		if ( typeof path != "string" ) {
			host = fn;
			fn = path;
			path = "/.*";
		}

		host = host || ALL;
		method = method || ALL;

		if ( typeof fn != "function" && ( fn && typeof fn.handle != "function" ) ) {
			throw new Error( "Invalid middleware" );
		}

		if ( !this.middleware[ host ] ) {
			this.middleware[ host ] = {};
		}

		if ( !this.middleware[ host ][ method ] ) {
			this.middleware[ host ][ method ] = {};
		}

		if ( !this.middleware[ host ][ method ][ path ] ) {
			this.middleware[ host ][ method ][ path ] = [];
		}

		if ( fn.handle ) {
			fn = fn.handle;
		}

		fn.hash = this.hash( fn.toString() );
		this.middleware[ host ][ method ][ path ].push( fn );

		return this;
	}

	/**
	 * Sets a handler for all methods
	 *
	 * @method all
	 * @param  {String}   route RegExp pattern
	 * @param  {Function} fn    Handler
	 * @param  {String}   host  [Optional] Virtual host, default is `all`
	 * @return {Object}         TurtleIO instance
	 */
	all ( route, fn, host ) {
		array.each( VERBS, ( i ) => {
			this.use( route, fn, host, i );
		} );

		return this;
	}

	/**
	 * Sets a DELETE handler
	 *
	 * @method delete
	 * @param  {String}   route RegExp pattern
	 * @param  {Function} fn    Handler
	 * @param  {String}   host  [Optional] Virtual host, default is `all`
	 * @return {Object}         TurtleIO instance
	 */
	del ( route, fn, host ) {
		return this.use( route, fn, host, "delete" );
	}

	/**
	 * Sets a DELETE handler
	 *
	 * @method delete
	 * @param  {String}   route RegExp pattern
	 * @param  {Function} fn    Handler
	 * @param  {String}   host  [Optional] Virtual host, default is `all`
	 * @return {Object}         TurtleIO instance
	 */
	delete ( route, fn, host ) {
		return this.use( route, fn, host, "delete" );
	}

	/**
	 * Sets a GET handler
	 *
	 * @method delete
	 * @param  {String}   route RegExp pattern
	 * @param  {Function} fn    Handler
	 * @param  {String}   host  [Optional] Virtual host, default is `all`
	 * @return {Object}         TurtleIO instance
	 */
	get ( route, fn, host ) {
		return this.use( route, fn, host, "get" );
	}

	/**
	 * Sets a PATCH handler
	 *
	 * @method delete
	 * @param  {String}   route RegExp pattern
	 * @param  {Function} fn    Handler
	 * @param  {String}   host  [Optional] Virtual host, default is `all`
	 * @return {Object}         TurtleIO instance
	 */
	patch ( route, fn, host ) {
		return this.use( route, fn, host, "patch" );
	}

	/**
	 * Sets a POST handler
	 *
	 * @method delete
	 * @param  {String}   route RegExp pattern
	 * @param  {Function} fn    Handler
	 * @param  {String}   host  [Optional] Virtual host, default is `all`
	 * @return {Object}         TurtleIO instance
	 */
	post ( route, fn, host ) {
		return this.use( route, fn, host, "post" );
	}

	/**
	 * Sets a PUT handler
	 *
	 * @method delete
	 * @param  {String}   route RegExp pattern
	 * @param  {Function} fn    Handler
	 * @param  {String}   host  [Optional] Virtual host, default is `all`
	 * @return {Object}         TurtleIO instance
	 */
	put ( route, fn, host ) {
		return this.use( route, fn, host, "put" );
	}

	/**
	 * Watches `path` for changes & updated LRU
	 *
	 * @method watcher
	 * @param  {String} url  LRUItem url
	 * @param  {String} path File path
	 * @return {Object}      TurtleIO instance
	 */
	watch ( url, path ) {
		let watcher;

		/**
		 * Cleans up caches
		 *
		 * @method cleanup
		 * @private
		 * @return {Undefined} undefined
		 */
		let cleanup = () => {
			watcher.close();
			this.unregister( url );
			delete this.watching[ path ];
		};

		if ( !( this.watching[ path ] ) ) {
			// Tracking
			this.watching[ path ] = 1;

			// Watching path for changes
			watcher = fs.watch( path, ( ev ) => {
				if ( regex.rename.test( ev ) ) {
					cleanup();
				} else {
					fs.lstat( path, ( e, stat ) => {
						let value;

						if ( e ) {
							this.log( e );
							cleanup();
						} else if ( this.etags.cache[ url ] ) {
							value = this.etags.cache[ url ].value;
							value.etag = this.etag( url, stat.size, stat.mtime );
							value.timestamp = parseInt( new Date().getTime() / 1000, 10 );
							this.register( url, value, true );
						} else {
							cleanup();
						}
					} );
				}
			} );
		}

		return this;
	}

	/**
	 * Writes files to disk
	 *
	 * @method write
	 * @param  {Object} req  HTTP request Object
	 * @param  {Object} res  HTTP response Object
	 * @param  {String} path File path
	 * @return {Object}      Promise
	 */
	write ( req, res, path ) {
		let timer = precise().start(),
			deferred = defer(),
			put = regex.put.test( req.method ),
			body = req.body,
			allow = req.allow,
			del = this.allowed( "DELETE", req.parsed.pathname, req.vhost ),
			status;

		if ( !put && regex.end_slash.test( req.url ) ) {
			status = this.codes[ del ? "CONFLICT" : "SERVER_ERROR" ];
			timer.stop();

			this.signal( "write", function () {
				return [ req.vhost, req.url, req.method, path, timer.diff() ];
			} );

			deferred.resolve( this.respond( req, res, this.page( status, this.hostname( req ) ), status, { allow: allow }, false ) );
		} else {
			allow = array.remove( string.explode( allow ), "POST" ).join( ", " );

			fs.lstat( path, ( e, stat ) => {
				let etag;

				if ( e ) {
					deferred.reject( new Error( this.codes.NOT_FOUND ) );
				} else {
					etag = "\"" + this.etag( req.parsed.href, stat.size, stat.mtime ) + "\"";

					if ( !req.headers.hasOwnProperty( "etag" ) || req.headers.etag === etag ) {
						fs.writeFile( path, body, e => {
							if ( e ) {
								deferred.reject( new Error( this.codes.SERVER_ERROR ) );
							} else {
								status = this.codes[ put ? "NO_CONTENT" : "CREATED" ];
								deferred.resolve( this.respond( req, res, this.page( status, this.hostname( req ) ), status, { allow: allow }, false ) );
							}
						} );
					} else if ( req.headers.etag !== etag ) {
						deferred.resolve( this.respond( req, res, this.messages.NO_CONTENT, this.codes.FAILED, {}, false ) );
					}
				}
			} );

			timer.stop();
			this.signal( "write", function () {
				return [ req.vhost, req.url, req.method, path, timer.diff() ];
			} );
		}

		return deferred.promise;
	}
}
