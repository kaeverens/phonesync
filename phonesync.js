function PhoneSync(params, callback) {
	this.options={
		'dbName':'tmp',
		'md5':false, // send MD5 checks
		'timeout':10, // milliseconds
		'updatesUrl':'', // URL of the API
		'failedApiCallTimeout':10000,
		'ready':function() { // called when the database is initialised
		},
		'syncDownloadsTimeout':60000,
		'tables':[], // list of tables to be synced
		'urls':{},
		'onBeforeNetwork':function() {
		},
		'onDownload':function() { // called when a new item is downloaded
		},
		'onNetwork':function() {
		},
		'onBeforeSave':function() { // called before an item is saved
		},
		'onSave':function() { // called after an item is saved
		},
		'onUpdate':function() { // called after an item is updated from server
		},
		'onUpload':function() { // called when an item is uploaded
		},
		'onDelete':function() { // called when a key is deleted
		}
	};
	$.extend(this.options, params);
	this.db=false;
	this.fs=false;
	this.disableFS=false;
	this.filePutQueue=[];
	this.fileGetQueue=[];
	this.networkInUse=false;
	this.loggedIn=false;
	this.tables={};
	this.cache={};
	this.apiCalls=[];
	for (var i=0;i<this.options.tables.length;++i) {
		this.tables[this.options.tables[i]]={
			'lastUpdate':'0000-00-00 00:00:00'
		}
	}
	var that=this;
	if (!Date.toYMD) {
		function Date_toYMD() {
			var year, month, day;
			year = String(this.getFullYear());
			month = String(this.getMonth() + 1);
			if (month.length == 1) {
				month = "0" + month;
			}
			day = String(this.getDate());
			if (day.length == 1) {
				day = "0" + day;
			}
			return year + "-" + month + "-" + day;
		}
		Date.prototype.toYMD = Date_toYMD;
	}
	if (/http:\/\//.test(document.location.toString())) {
		setTimeout(function() {
			that.syncDownloads();
			that.syncUploads();
		}, that.options.timeout);
		that.options.ready(this);
	}
	else {
		window.requestFileSystem(
			LocalFileSystem.PERSISTENT, 0,
			function(filesystem) {
				var entry=filesystem.root;
				entry.getDirectory(that.options.dbName,
					{'create':true, 'exclusive':false},
					function(root) {
						that.fs=root;
						clearTimeout(window.PhoneSync_timerSyncUploads);
						clearTimeout(window.PhoneSync_timerSyncDownloads);
						setTimeout(function() {
							that.syncDownloads();
							that.syncUploads();
						}, that.options.timeout);
						that.options.ready(that);
						that.get('_tables', function(ret) {
							if (ret===null) {
								return;
							}
							$.extend(that.tables, ret.obj);
						});
						that.get('_files', function(ret) {
							if (ret===null) {
								ret={
									'key':'_files',
									'files':{'_files':1}
								};
								that.save(ret, null, true);
							}
						});
					}
				);
			},
			null
		);
	}
	document.addEventListener('online', function() {
		clearTimeout(window.PhoneSync_timerSyncUploads);
		clearTimeout(window.PhoneSync_timerSyncDownloads);
		setTimeout(function() {
			that.syncDownloads();
			that.syncUploads();
		}, that.options.timeout);
	}, false);
}
PhoneSync.prototype.addToSyncUploads=function(key) {
	var that=this;
	var table=key.replace(/-.*/, '');
	this.get('_syncUploads', function(ret) {
		if (!ret || ret===undefined) {
			ret={
				'key':'_syncUploads',
				'keys':[]
			}
		}
		if ($.inArray(key, ret.keys)>0) {
			return;
		}
		ret.keys.push(key);
		that.save(ret, false, true);
	});
	clearTimeout(window.PhoneSync_timerSyncUploads);
	window.PhoneSync_timerSyncUploads=setTimeout(function() {
		that.syncUploads();
	}, that.options.timeout);
}
PhoneSync.prototype.api=function(action, params, success, fail) {
	var that=this;
	var _v=1;
	var uid=0;
	if (window.userdata) {
		params._userdata={
			'username':userdata.username,
			'password':userdata.password
		};
		uid=userdata.id;
	}
	else if (window.credentials) {
		params._userdata={
			'username':credentials.email,
			'password':credentials.password
		};
		uid=credentials.user_id;
	}
	if (this.options.urls[action]===undefined) {
		console.log('no url defined for the action: '+action);
		return;
	}
	var url=this.options.urls[action]+'/_v='+_v+'/_t='+(new Date).toYMD();
	var lastUpdates={};
	$.each(this.tables, function(k, v) {
		lastUpdates[k]=v.lastUpdate;
	});
	if (action=='syncDownloads') {
		params._lastUpdates=lastUpdates;
	}
	params._uuid=(device&&device.uuid)?device.uuid:'no-uid|'+uid;
	this.uuid=params._uuid;
	$.each(params, function(k, v) {
		if (v===true) {
			params[k]=1;
		}
	});
	function recursiveClean(obj) {
		for (var prop in obj) {
			if (obj.hasOwnProperty(prop)) {
				if (typeof obj[prop]=="object"){
					recursiveClean(obj[prop]);
				}
				else {
					if (obj[prop]===true) {
						obj[prop]=1;
					}
				}
			}
		}
	}
	recursiveClean(params);
	if (this.options.md5) {
		var json=JSON.stringify(params, function(k, v) {
			if (v===null) {
				return '';
			}
			if (v===+v) {
				return v.toString();
			}
			return v;
		});
		json=json
			.replace(/,"[^"]*":\[\]/, '')
			.replace(/"[^"]*":\[\],/, '')
			.replace(/[\u2018\u2019]/g, "'")
			.replace(/[\u201C\u201D]/g, '"');
		params._md5=this.md5(json);
		console.log(params._md5);
		console.log(json);
	}
	if (!fail) {
		fail=function(ret) {
			console.error(JSON.stringify(ret));
		}
	}
	console.log('api request added to queue');
	this.apiCalls.push([url, params, success, fail, action]);
	this.apiNext();
}
PhoneSync.prototype.apiNext=function() {
	var that=this;
	if (navigator.connection.type==Connection.NONE) {
		console.error('no network');
		return setTimeout(
			function() {
				that.apiNext();
			},
			5000
		);
	}
	clearTimeout(window.PhoneSync_timerApiCall);
	if (!this.apiCalls.length) {
		return;
	}
	if (this.networkInUse) {
		window.PhoneSync_timerApiCall=setTimeout(
			function() {
				that.apiNext();
			},
			that.options.failedApiCallTimeout
		);
		return;
	}
	this.networkInUse=true;
	this.options.onBeforeNetwork();
	var call=false;
	for (var i=0;i<this.apiCalls.length;++i) {
		if (this.apiCalls[i][4]=='syncUploads') {
			var call=this.apiCalls[i];
			this.apiCalls.splice(i, 1);
			break;
		}
	}
	if (!call) {
		call=this.apiCalls.shift();
	}
	var url=call[0], params=call[1], success=call[2], fail=call[3]
		, action=call[4];
	console.log(url, params);
	$.post(url, params)
		.done(function(ret) {
			that.options.onNetwork();
			if (!ret) {
				console.error('error while sending request');
				console.log(url, params, ret);
				return fail({'err':'error while sending request'});
			}
			if (ret.error) {
				console.log('Error: '+ret.error);
				fail(ret);
			}
			else {
				if (action=='login') {
					window.userdata=ret;
					that.loggedIn=true;
				}
				if (success) {
					success(ret);
				}
			}
		})
		.fail(function(e) {
			if (call[4]=='syncUploads') {
				that.apiCalls.unshift(call);
			}
			else {
				that.apiCalls.push(call);
			}
			fail();
		})
		.always(function(stuff) {
			that.networkInUse=false;
			clearTimeout(window.PhoneSync_timerApiCall);
			window.PhoneSync_timerApiCall=setTimeout(
				function() {
					that.apiNext();
				},
				1000
			);
		});
}
PhoneSync.prototype.delete=function(key, callback, nosync) {
	var that=this;
	if (this.disableFS) {
		return;
	}
	delete this.cache[key];
	if (/-/.test(key)) {
		this.idDel(key.replace(/-[^-]*$/, ''), key.replace(/.*-/, ''));
	}
	if (callback) {
		callback();
	}
	this.fs.getFile(key, {create: false, exclusive: false}, function(file) {
		file.remove();
		that.get('_files', function(ret) {
			if (ret===null) {
				return;
			}
			if (ret.files[key]) {
				delete ret.files[key];
				that.save(ret);
			}
		});
	});
	this.options.onDelete(key);
}
PhoneSync.prototype.get=function(key, callback, download) {
	var that=this;
	function fail() {
		var arr=[];
		for (var i=0;i<that.fileGetQueue.length;++i) {
			if (that.fileGetQueue[i]!=key) {
				arr.push(that.fileGetQueue[i]);
			}
		}
		that.fileGetQueue=arr;
		callback(null);
	}
	if (this.disableFS) {
		return;
	}
	if (this.cache[key]) {
		if (!(this.cache[key]===null && download)) {
			return callback($.extend({}, this.cache[key]));
		}
	}
	if (this.cache._files) {
		if (this.cache._files.files[key]===undefined && !download) {
			return fail();
		}
	}
	for (var i=0;i<this.fileGetQueue.length;++i) {
		if (this.fileGetQueue[i]==key) {
			setTimeout(function() {
				that.get(key, callback, download);
			}, that.options.timeout);
			return;
		}
	}
	this.fileGetQueue.push(key);
	var that=this;
	this.fileGetJSON(key,
		function(obj) {
			var arr=[];
			for (var i=0;i<that.fileGetQueue.length;++i) {
				if (that.fileGetQueue[i]!=key) {
					arr.push(that.fileGetQueue[i]);
				}
			}
			that.fileGetQueue=arr;
			that.cache[key]=obj;
			callback($.extend({}, obj));
		},
		function() {
			if (download) {
				that.api('syncDownloadOne', {
					'key':key
				}, function(ret) {
					var obj={
						'key':key,
						'obj':ret
					};
					that.save(obj);
					callback(obj);
				}, fail, function() {
					console.log('offline - cannot download missing resource: '+key);
				});
			}
			else {
				fail();
			}
		}
	);
}
PhoneSync.prototype.getAll=function(key, callback) {
	var that=this;
	if (this.disableFS) {
		return;
	}
	var keys=[];
	if (this.cache[key]) {
		var keys=this.cache[key].obj;
	}
	else {
		this.get(key, function(ret) {
			if (ret===undefined || ret===null) {
				return callback([]);
			}
			that.getAll(key, callback);
		});
		return;
	}
	var rows=[];
	var toGet=keys.length;
	for (var i=0;i<keys.length;++i) {
		this.get(key+'-'+keys[i], function(ret) {
			rows.push($.extend({}, ret));
			toGet--;
			if (!toGet) {
				callback(rows);
			}
		});
	}
}
PhoneSync.prototype.getAllById=function(keys, callback) {
	var that=this;
	if (this.disableFS) {
		return;
	}
	var rows=[];
	var toGet=keys.length;
	for (var i=0;i<keys.length;++i) {
		this.get(keys[i], function(ret) {
			rows.push($.extend({}, ret));
			toGet--;
			if (!toGet) {
				callback(rows);
			}
		});
	}
}
PhoneSync.prototype.idAdd=function(name, id, callback) {
	var that=this;
	id=''+id;
	this.get(name, function(ret) {
		if (ret===undefined || ret===null) {
			ret={
				'obj':[]
			};
		}
		if ($.inArray(id, ret.obj)===-1) {
			ret.obj.push(id);
			that.save({
				'key':name,
				'obj':ret.obj,
				'id':id // added to let recursive idAdd work
			}, callback , true);
		}
		else {
			if (callback) {
				callback();
			}
		}
	});
}
PhoneSync.prototype.idDel=function(name, id) {
	var that=this;
	id=''+id;
	this.get(name, function(ret) {
		if (ret===undefined || ret===null) {
			ret={
				'obj':[]
			};
		}
		var arr=[];
		for (var i=0;i<ret.obj.length;++i) {
			if (id == ret.obj[i]) {
				continue;
			}
			arr.push(ret.obj[i]);
		}
		that.save({
			'key':name,
			'obj':arr,
			'id':id // added to let recursive idAdd work
		}, false, true);
	});
}
PhoneSync.prototype.filePutJSON=function(name, obj, callback) {
	var that=this;
	if (this.disableFS) {
		return callback?callback():0;
	}
	// { if a file is submitted, queue it and come back later
	if (name && obj) {
		for (var i=1;i<this.filePutQueue.length;++i) {
			var f=this.filePutQueue[i];
			if (f[0]==name) {
				this.filePutQueue[i]=this.filePutQueue[this.filePutQueue.length-1];
				this.filePutQueue.pop();
				break;
			}
		}
		this.filePutQueue.push([name, obj, callback]);
		clearTimeout(window.PhoneSync_timerFilePutQueue);
		window.PhoneSync_timerFilePutQueue=setTimeout(function() {
			that.filePutJSON()
		}, that.options.timeout);
		return;
	}
	// }
	// { check to see if there is already a file being written
	if (this.filePutJSONLock) {
		clearTimeout(window.PhoneSync_timerFilePutQueue);
		window.PhoneSync_timerFilePutQueue=setTimeout(function() {
			that.filePutJSON()
		}, that.options.timeout);
		return;
	}
	// }
	// { write a file
	this.filePutJSONLock=true;
	var o=this.filePutQueue.shift();
	if (o) {
		var name=o[0], obj=o[1], callback=o[2];
		var json=JSON.stringify(obj);
		this.fs.getFile(this.sanitise(name), {'create':true, 'exclusive':false},
			function(entry) {
				entry.createWriter(function(writer) {
					writer.onwriteend=function() {
						if (callback) {
							callback();
						}
						if (name!=='_files') {
							that.get('_files', function(ret) {
								if (ret===null) {
									ret={
										'key':'_files',
										'files':{'_files':1}
									};
								}
								if (ret.files[name]===undefined) {
									ret.files[name]=1;
									that.save(ret, null, true);
								}
							});
						}
						that.filePutJSONLock=false;
						if (that.filePutQueue.length) {
							clearTimeout(window.PhoneSync_timerFilePutQueue);
							window.PhoneSync_timerFilePutQueue=setTimeout(function() {
								that.filePutJSON()
							}, that.options.timeout);
						}
					}
					writer.write(json);
				},
				function() { // failed to create writer
					console.error('failed to create writer');
					that.filePutQueue.unshift(o);
					clearTimeout(window.PhoneSync_timerFilePutQueue);
					window.PhoneSync_timerFilePutQueue=setTimeout(function() {
						that.filePutJSON()
					}, that.options.timeout);
				});
			}
		);
	}
	else {
		if (this.filePutQueue.length) {
			clearTimeout(window.PhoneSync_timerFilePutQueue);
			window.PhoneSync_timerFilePutQueue=setTimeout(function() {
				that.filePutJSON()
			}, that.options.timeout);
		}
	}
	// }
}
PhoneSync.prototype.fileGetJSON=function(name, success, fail) {
	var that=this;
	if (this.disableFS) {
		return;
	}
	if (!this.fs) {
		return setTimeout(function() {
			that.fileGetJSON(name, success, fail);
		}, that.options.timeout);
	}
	this.fs.getFile(this.sanitise(name), {'create':false, 'exclusive':false},
		function(entry) {
			entry.file(
				function(file) {
					var reader=new FileReader();
					reader.onloadend=function(evt) {
						if (evt.target.result) {
							success(JSON.parse(evt.target.result));
						}
						else {
							fail();
						}
					}
					reader.readAsText(file);
				},
				fail
			);
		},
		fail
	);
}
PhoneSync.prototype.md5=function(str) {
  //  discuss at: http://phpjs.org/functions/md5/
  // original by: Webtoolkit.info (http://www.webtoolkit.info/)
  // improved by: Michael White (http://getsprink.com)
  // improved by: Jack
  // improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  //    input by: Brett Zamir (http://brett-zamir.me)
  // bugfixed by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  //  depends on: utf8_encode
  //   example 1: md5('Kevin van Zonneveld');
  //   returns 1: '6e658d4bfcb59cc13f96c14450ac40b9'

  var xl;

  var rotateLeft = function (lValue, iShiftBits) {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  };

  var addUnsigned = function (lX, lY) {
    var lX4, lY4, lX8, lY8, lResult;
    lX8 = (lX & 0x80000000);
    lY8 = (lY & 0x80000000);
    lX4 = (lX & 0x40000000);
    lY4 = (lY & 0x40000000);
    lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
    if (lX4 & lY4) {
      return (lResult ^ 0x80000000 ^ lX8 ^ lY8);
    }
    if (lX4 | lY4) {
      if (lResult & 0x40000000) {
        return (lResult ^ 0xC0000000 ^ lX8 ^ lY8);
      } else {
        return (lResult ^ 0x40000000 ^ lX8 ^ lY8);
      }
    } else {
      return (lResult ^ lX8 ^ lY8);
    }
  };

  var _F = function (x, y, z) {
    return (x & y) | ((~x) & z);
  };
  var _G = function (x, y, z) {
    return (x & z) | (y & (~z));
  };
  var _H = function (x, y, z) {
    return (x ^ y ^ z);
  };
  var _I = function (x, y, z) {
    return (y ^ (x | (~z)));
  };

  var _FF = function (a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(_F(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  };

  var _GG = function (a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(_G(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  };

  var _HH = function (a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(_H(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  };

  var _II = function (a, b, c, d, x, s, ac) {
    a = addUnsigned(a, addUnsigned(addUnsigned(_I(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  };

  var convertToWordArray = function (str) {
    var lWordCount;
    var lMessageLength = str.length;
    var lNumberOfWords_temp1 = lMessageLength + 8;
    var lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
    var lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
    var lWordArray = new Array(lNumberOfWords - 1);
    var lBytePosition = 0;
    var lByteCount = 0;
    while (lByteCount < lMessageLength) {
      lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = (lWordArray[lWordCount] | (str.charCodeAt(lByteCount) << lBytePosition));
      lByteCount++;
    }
    lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
    lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
    lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
    return lWordArray;
  };

  var wordToHex = function (lValue) {
    var wordToHexValue = '',
      wordToHexValue_temp = '',
      lByte, lCount;
    for (lCount = 0; lCount <= 3; lCount++) {
      lByte = (lValue >>> (lCount * 8)) & 255;
      wordToHexValue_temp = '0' + lByte.toString(16);
      wordToHexValue = wordToHexValue + wordToHexValue_temp.substr(wordToHexValue_temp.length - 2, 2);
    }
    return wordToHexValue;
  };

  var x = [],
    k, AA, BB, CC, DD, a, b, c, d, S11 = 7,
    S12 = 12,
    S13 = 17,
    S14 = 22,
    S21 = 5,
    S22 = 9,
    S23 = 14,
    S24 = 20,
    S31 = 4,
    S32 = 11,
    S33 = 16,
    S34 = 23,
    S41 = 6,
    S42 = 10,
    S43 = 15,
    S44 = 21;

  str = this.utf8_encode(str);
  x = convertToWordArray(str);
  a = 0x67452301;
  b = 0xEFCDAB89;
  c = 0x98BADCFE;
  d = 0x10325476;

  xl = x.length;
  for (k = 0; k < xl; k += 16) {
    AA = a;
    BB = b;
    CC = c;
    DD = d;
    a = _FF(a, b, c, d, x[k + 0], S11, 0xD76AA478);
    d = _FF(d, a, b, c, x[k + 1], S12, 0xE8C7B756);
    c = _FF(c, d, a, b, x[k + 2], S13, 0x242070DB);
    b = _FF(b, c, d, a, x[k + 3], S14, 0xC1BDCEEE);
    a = _FF(a, b, c, d, x[k + 4], S11, 0xF57C0FAF);
    d = _FF(d, a, b, c, x[k + 5], S12, 0x4787C62A);
    c = _FF(c, d, a, b, x[k + 6], S13, 0xA8304613);
    b = _FF(b, c, d, a, x[k + 7], S14, 0xFD469501);
    a = _FF(a, b, c, d, x[k + 8], S11, 0x698098D8);
    d = _FF(d, a, b, c, x[k + 9], S12, 0x8B44F7AF);
    c = _FF(c, d, a, b, x[k + 10], S13, 0xFFFF5BB1);
    b = _FF(b, c, d, a, x[k + 11], S14, 0x895CD7BE);
    a = _FF(a, b, c, d, x[k + 12], S11, 0x6B901122);
    d = _FF(d, a, b, c, x[k + 13], S12, 0xFD987193);
    c = _FF(c, d, a, b, x[k + 14], S13, 0xA679438E);
    b = _FF(b, c, d, a, x[k + 15], S14, 0x49B40821);
    a = _GG(a, b, c, d, x[k + 1], S21, 0xF61E2562);
    d = _GG(d, a, b, c, x[k + 6], S22, 0xC040B340);
    c = _GG(c, d, a, b, x[k + 11], S23, 0x265E5A51);
    b = _GG(b, c, d, a, x[k + 0], S24, 0xE9B6C7AA);
    a = _GG(a, b, c, d, x[k + 5], S21, 0xD62F105D);
    d = _GG(d, a, b, c, x[k + 10], S22, 0x2441453);
    c = _GG(c, d, a, b, x[k + 15], S23, 0xD8A1E681);
    b = _GG(b, c, d, a, x[k + 4], S24, 0xE7D3FBC8);
    a = _GG(a, b, c, d, x[k + 9], S21, 0x21E1CDE6);
    d = _GG(d, a, b, c, x[k + 14], S22, 0xC33707D6);
    c = _GG(c, d, a, b, x[k + 3], S23, 0xF4D50D87);
    b = _GG(b, c, d, a, x[k + 8], S24, 0x455A14ED);
    a = _GG(a, b, c, d, x[k + 13], S21, 0xA9E3E905);
    d = _GG(d, a, b, c, x[k + 2], S22, 0xFCEFA3F8);
    c = _GG(c, d, a, b, x[k + 7], S23, 0x676F02D9);
    b = _GG(b, c, d, a, x[k + 12], S24, 0x8D2A4C8A);
    a = _HH(a, b, c, d, x[k + 5], S31, 0xFFFA3942);
    d = _HH(d, a, b, c, x[k + 8], S32, 0x8771F681);
    c = _HH(c, d, a, b, x[k + 11], S33, 0x6D9D6122);
    b = _HH(b, c, d, a, x[k + 14], S34, 0xFDE5380C);
    a = _HH(a, b, c, d, x[k + 1], S31, 0xA4BEEA44);
    d = _HH(d, a, b, c, x[k + 4], S32, 0x4BDECFA9);
    c = _HH(c, d, a, b, x[k + 7], S33, 0xF6BB4B60);
    b = _HH(b, c, d, a, x[k + 10], S34, 0xBEBFBC70);
    a = _HH(a, b, c, d, x[k + 13], S31, 0x289B7EC6);
    d = _HH(d, a, b, c, x[k + 0], S32, 0xEAA127FA);
    c = _HH(c, d, a, b, x[k + 3], S33, 0xD4EF3085);
    b = _HH(b, c, d, a, x[k + 6], S34, 0x4881D05);
    a = _HH(a, b, c, d, x[k + 9], S31, 0xD9D4D039);
    d = _HH(d, a, b, c, x[k + 12], S32, 0xE6DB99E5);
    c = _HH(c, d, a, b, x[k + 15], S33, 0x1FA27CF8);
    b = _HH(b, c, d, a, x[k + 2], S34, 0xC4AC5665);
    a = _II(a, b, c, d, x[k + 0], S41, 0xF4292244);
    d = _II(d, a, b, c, x[k + 7], S42, 0x432AFF97);
    c = _II(c, d, a, b, x[k + 14], S43, 0xAB9423A7);
    b = _II(b, c, d, a, x[k + 5], S44, 0xFC93A039);
    a = _II(a, b, c, d, x[k + 12], S41, 0x655B59C3);
    d = _II(d, a, b, c, x[k + 3], S42, 0x8F0CCC92);
    c = _II(c, d, a, b, x[k + 10], S43, 0xFFEFF47D);
    b = _II(b, c, d, a, x[k + 1], S44, 0x85845DD1);
    a = _II(a, b, c, d, x[k + 8], S41, 0x6FA87E4F);
    d = _II(d, a, b, c, x[k + 15], S42, 0xFE2CE6E0);
    c = _II(c, d, a, b, x[k + 6], S43, 0xA3014314);
    b = _II(b, c, d, a, x[k + 13], S44, 0x4E0811A1);
    a = _II(a, b, c, d, x[k + 4], S41, 0xF7537E82);
    d = _II(d, a, b, c, x[k + 11], S42, 0xBD3AF235);
    c = _II(c, d, a, b, x[k + 2], S43, 0x2AD7D2BB);
    b = _II(b, c, d, a, x[k + 9], S44, 0xEB86D391);
    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }

  var temp = wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);

  return temp.toLowerCase();
}
PhoneSync.prototype.nuke=function(callback) {
	var that=this;
	this.disableFS=true;
	try {
		this.fs.removeRecursively(function() {
			window.requestFileSystem(
				LocalFileSystem.PERSISTENT, 0,
				function(filesystem) {
					var entry=filesystem.root;
					function createRoot() {
						entry.getDirectory(
							that.options.dbName,
							{'create':true, 'exclusive':false},
							function(root) {
								that.fs=root;
								that.disableFS=false;
								clearTimeout(window.PhoneSync_timerSyncUploads);
								clearTimeout(window.PhoneSync_timerSyncDownloads);
								setTimeout(function() {
									that.syncDownloads();
									that.syncUploads();
								}, that.options.timeout);
								that.options.ready(that);
								for (var i in that.tables) {
									that.tables[i].lastUpdate='0000-00-00 00:00:00';
								}
								that.save( { 'key':'_tables', 'obj':that.tables }, false, true);
								callback();
							},
							function(e) {
								console.log(e);
								setTimeout(createRoot, that.options.timeout);
							}
						);
					}
					createRoot();
				},
				function(e) {
					console.log(e);
				}
			);
		});
	}
	catch (e) {
		console.log(e);
	}
	for (var i=0;i<this.options.tables.length;++i) {
		this.tables[this.options.tables[i]]={
			'lastUpdate':'0000-00-00 00:00:00'
		}
	}
	this.cache={};
}
PhoneSync.prototype.rekey=function(table, oldId, newId, callback) {
	var that=this;
	if (oldId==newId) {
		return;
	}
	this.get(table+'-'+oldId, function(obj) {
		obj.key=table+'-'+newId;
		obj.obj.id=newId;
		that.save(obj, callback, true);
		that.delete(table+'-'+oldId);
	});
}
PhoneSync.prototype.sanitise=function(name) {
	return name.replace(/[^a-zA-Z0-9\-]/g, '');
}
PhoneSync.prototype.save=function(obj, callback, nosync) {
	var that=this;
	this.options.onBeforeSave(obj.key, obj);
	function onSave() {
		that.options.onSave(obj.key, obj);
	}
	if (this.disableFS) {
		return;
	}
	this.cache[obj.key]=obj;
	if (/-/.test(obj.key)) {
		var id=obj.obj && obj.obj.id ? obj.obj.id : obj.id;
		this.idAdd(obj.key.replace(/-[^-]*$/, ''), id, function() {
			if (callback) {
				callback();
			}
			if (!(nosync || /^_/.test(obj.key))) {
				that.addToSyncUploads(obj.key);
			}
			that.filePutJSON(obj.key, obj, onSave);
		});
	}
	else {
		if (callback) {
			callback();
		}
		if (!nosync) {
			this.addToSyncUploads(obj.key);
		}
		this.filePutJSON(obj.key, obj, onSave);
	}
}
PhoneSync.prototype.syncDownloads=function() {
	var that=this;
	if (this.disableFS) {
		console.log('fs disabled');
		return;
	}
	clearTimeout(window.PhoneSync_timerSyncDownloads);
	if (!this.loggedIn) {
		window.PhoneSync_timerSyncDownloads=setTimeout(function() {
			that.syncDownloads();
		}, 15000);
		console.log('not logged in. will sync downloads in 15s');
		return;
	}
	console.log('about to sync downloads');
	this.api(
		'syncDownloads', {},
		function(ret) {
			var deletes=[], changes=0;
			$.each(ret, function(k, v) {
				if (!$.isArray(v)) {
					return;
				}
				if (k=='_deletes') {
					deletes=v;
				}
				var tableUpdatesChanged=false;
				for (var i=0;i<v.length;++i) {
					var obj=v[i];
					if (!that.tables[k].lastUpdate
						|| obj.last_edited>that.tables[k].lastUpdate
					) {
						that.tables[k].lastUpdate=obj.last_edited;
						tableUpdatesChanged=true;
						changes++;
					}
					if (k!=='_deletes') {
						(function(k, obj) {
							that.get(k+'-'+obj.id, function(ret) {
								if (ret===null) {
									that.options.onDownload(k+'-'+obj.id, obj);
								}
								if (that.uuid==obj.uuid) { // originally came from device
									if (ret===null) {
										that.save({
											'key':k+'-'+obj.id,
											'obj':obj
										}, false, true);
										that.options.onUpdate(k+'-'+obj.id, obj);
									}
								}
								else { // created somewhere else
									that.save({
										'key':k+'-'+obj.id,
										'obj':obj
									}, false, true);
									that.options.onUpdate(k+'-'+obj.id, obj);
								}
							});
						})(k, obj);
					}
				}
				if (tableUpdatesChanged) {
					that.save( { 'key':'_tables', 'obj':that.tables }, false, true);
				}
			});
			for (var i=0;i<deletes.length;++i) {
				if (deletes[i].key===undefined) {
					deletes[i].key=deletes[i].table_name+'-'+deletes[i].item_id;
				}
				that.delete(deletes[i].key);
				changes++;
			}
			clearTimeout(window.PhoneSync_timerSyncDownloads);
			if (changes) {
				window.PhoneSync_timerSyncDownloads=setTimeout(function() {
					that.syncDownloads();
				}, that.options.timeout);
			}
			else {
				window.PhoneSync_timerSyncDownloads=setTimeout(function() {
					that.syncDownloads();
				}, that.options.syncDownloadsTimeout);
			}
		},
		function(err) {
			console.log('failed');
			clearTimeout(window.PhoneSync_timerSyncDownloads);
			window.PhoneSync_timerSyncDownloads=setTimeout(function() {
				that.syncDownloads();
			}, that.options.syncDownloadsTimeout);
		}
	);
}
PhoneSync.prototype.syncUploads=function() {
	var that=this;
	if (this.disableFS) {
		return;
	}
	clearTimeout(window.PhoneSync_timerSyncUploads);
	window.PhoneSync_timerSyncUploads=setTimeout(function() {
		that.syncUploads();
	}, 60000);
	this.get('_syncUploads', function(obj) {
		if (!obj || obj===undefined || obj.keys.length==0) {
			return;
		}
		var key=obj.keys[0];
		if (/^_/.test(key)) {
			obj.keys.shift();
			that.save(obj, function() { // remove this item from the queue
				clearTimeout(window.PhoneSync_timerSyncUploads);
				window.PhoneSync_timerSyncUploads=setTimeout(function() {
					that.syncUploads();
				}, that.options.timeout);
			}, true);
			return;
		}
		that.get(key, function(ret) {
			if (ret===null) {
				obj.keys.shift();
				console.log('ret is null. removing');
				that.save(obj, function() { // remove this item from the queue
					clearTimeout(window.PhoneSync_timerSyncUploads);
					window.PhoneSync_timerSyncUploads=setTimeout(
						function() {
							that.syncUploads()
						},
						that.options.timeout
					);
				}, true);
				return;
			}
			that.api(
				'syncUploads', ret,
				function(ret) { //  success
					obj.keys.shift();
					that.save(obj, function() { // remove this item from the queue
						clearTimeout(window.PhoneSync_timerSyncUploads);
						window.PhoneSync_timerSyncUploads=setTimeout(function() {
							that.syncUploads();
						}, that.options.timeout);
						if (ret) {
							that.options.onUpload(key, ret);
						}
					}, true);
				},
				function(ret) { // fail
					console.log('PhoneSync: syncUploads() fail.');
					clearTimeout(window.PhoneSync_timerSyncUploads);
					window.PhoneSync_timerSyncUploads=setTimeout(
						function() {
							that.syncUploads
						},
						that.options.timeout
					);
				}
			);
		});
	});
}
PhoneSync.prototype.utf8_encode=function(argString) {
  //  discuss at: http://phpjs.org/functions/utf8_encode/
  // original by: Webtoolkit.info (http://www.webtoolkit.info/)
  // improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  // improved by: sowberry
  // improved by: Jack
  // improved by: Yves Sucaet
  // improved by: kirilloid
  // bugfixed by: Onno Marsman
  // bugfixed by: Onno Marsman
  // bugfixed by: Ulrich
  // bugfixed by: Rafal Kukawski
  // bugfixed by: kirilloid
  //   example 1: utf8_encode('Kevin van Zonneveld');
  //   returns 1: 'Kevin van Zonneveld'

  if (argString === null || typeof argString === 'undefined') {
    return '';
  }

  // .replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var string = (argString + '');
  var utftext = '',
    start, end, stringl = 0;

  start = end = 0;
  stringl = string.length;
  for (var n = 0; n < stringl; n++) {
    var c1 = string.charCodeAt(n);
    var enc = null;

    if (c1 < 128) {
      end++;
    } else if (c1 > 127 && c1 < 2048) {
      enc = String.fromCharCode(
        (c1 >> 6) | 192, (c1 & 63) | 128
      );
    } else if ((c1 & 0xF800) != 0xD800) {
      enc = String.fromCharCode(
        (c1 >> 12) | 224, ((c1 >> 6) & 63) | 128, (c1 & 63) | 128
      );
    } else {
      // surrogate pairs
      if ((c1 & 0xFC00) != 0xD800) {
        throw new RangeError('Unmatched trail surrogate at ' + n);
      }
      var c2 = string.charCodeAt(++n);
      if ((c2 & 0xFC00) != 0xDC00) {
        throw new RangeError('Unmatched lead surrogate at ' + (n - 1));
      }
      c1 = ((c1 & 0x3FF) << 10) + (c2 & 0x3FF) + 0x10000;
      enc = String.fromCharCode(
        (c1 >> 18) | 240, ((c1 >> 12) & 63) | 128, ((c1 >> 6) & 63) | 128, (c1 & 63) | 128
      );
    }
    if (enc !== null) {
      if (end > start) {
        utftext += string.slice(start, end);
      }
      utftext += enc;
      start = end = n + 1;
    }
  }

  if (end > start) {
    utftext += string.slice(start, stringl);
  }

  return utftext;
}
