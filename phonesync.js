function PhoneSync(params) {
	if (!window.Connection) {
		window.Connection={
			'NONE':0
		};
	}
	this.options={
		'dbName':'tmp',
		'dbType':params.dbType
			|| (/http/.test(document.location.toString())?'indexeddb':'file'),
		'timeout':1000, // milliseconds
		'version':0, // version parameter to send to server as _v
		'updatesUrl':'', // URL of the API
		'failedApiCallTimeout':10000,
		'ready':function(obj) { // called when the database is initialised
		},
		'syncDownloadsTimeout':60000,
		'tables':[], // list of tables to be synced
		'nonIndexableFiles':/^$/, // regexp of files not to be indexed
		'urls':{},
		'onBeforeNetwork':function() {
		},
		'onDownload':function() { // called when a new item is downloaded
		},
		'onErrorHandler':function(e) { // catchall fail callback
			console.log(e);
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
	this.fs=false;
	this.numberOfUploads=0;
	this.allowDownloads=true; // don't allow downloads to happen while uploads are pending
	this.disableFS=false;
	this.filePutQueue=[];
	this.fileGetQueue=[];
	this.networkInUse=false;
	this.loggedIn=false;
	this.tables={};
	this.cache={};
	this.apiCalls=[];
	this.tablesLastUpdateClear();
	var that=this;
	Date.prototype.toYMD = function Date_toYMD() {
		var year, month, day;
		year = String(this.getFullYear());
		month = String(this.getMonth() + 1);
		if (1 === month.length) {
			month = "0" + month;
		}
		day = String(this.getDate());
		if (1 === day.length) {
			day = "0" + day;
		}
		return year + "-" + month + "-" + day;
	};
	if (this.options.dbType=='file') {
		window.requestFileSystem(
			LocalFileSystem.PERSISTENT, 0,
			function(filesystem) {
				var entry=filesystem.root;
				entry.getDirectory(that.options.dbName,
					{'create':true, 'exclusive':false},
					function(root) {
						that.fs=root;
						that.delaySyncDownloads();
						that.delaySyncUploads();
						that.get('_tables', function(ret) {
							if (null === ret) {
								return;
							}
							$.extend(that.tables, ret.obj);
						});
						that.get('_files', function(ret) {
							if (null === ret) {
								that.save({
									'key':'_files',
									'files':{'_files':1}
								}, null, true);
							}
						});
						that.options.ready(that);
						var dirReader=root.createReader();
						dirReader.readEntries(function(entries) {
							var files=[];
							for (var i=0;i<entries.length;++i) {
								var entry=entries[i];
								if (entry.isFile) {
									files.push(entry.name);
								}
							}
						}, function(err) {
							console.log('error starting index checker');
							console.log(err);
						});
					}
				);
			},
			null
		);
	}
	else if (this.options.dbType=='indexeddb') {
		try {
			that.dbSetupIndexedDB();
		}
		catch (e) {
			console.log(e);
		}
	}
	else {
		that.save({
			'key':'_files',
			'files':{'_files':1}
		}, null, true);
		setTimeout(function() {
			that.options.ready(that);
			$(document).trigger('online');
		}, 1);
	}
	$(document).bind('online', function() {
		that.delaySyncDownloads();
		that.delaySyncUploads();
	});
	setInterval(function() {
		console.log('triggering uploads/downloads just in case');
		that.delaySyncUploads();
		that.delaySyncDownloads();
	}, 60000);
}
PhoneSync.prototype.addToSyncUploads=function(key) {
	var that=this;
	this.get('_syncUploads', function(ret) {
		if (!ret || ret===undefined || ret.keys===undefined) {
			ret={
				'key':'_syncUploads',
				'keys':[]
			};
		}
		if (0 < $.inArray(key, ret.keys)) {
			return;
		}
		ret.keys.push(key);
		that.save(ret, false, true);
	});
	that.delaySyncUploads();
};
PhoneSync.prototype.api=function(action, params, success, fail) {
	var uid=0;
	if (window.credentials) {
		if (credentials.email && credentials.password) {
			params._userdata={
				'username':credentials.email,
				'password':credentials.password
			};
		}
		uid=credentials.user_id;
		if (credentials.session_id) {
			params.PHPSESSID=credentials.session_id;
		}
	}
	if (this.options.urls[action]===undefined) {
		console.log('no url defined for the action', action);
		fail();
		return;
	}
	var url=this.options.urls[action];
	if ('syncDownloads' === action) {
		var lastUpdates={};
		$.each(this.tables, function(k, v) {
			lastUpdates[k]='0000-00-00 00:00:00' === v.lastUpdate ? 0 : v.lastUpdate;
		});
		params._lastUpdates=lastUpdates;
	}
	if (this.options.version) {
		params._v=this.options.version;
	}
	params._uuid=(window.device&&device.uuid)?device.uuid:'no-uid|'+uid;
	this.uuid=params._uuid;
	function recursiveClean(obj) {
		for (var prop in obj) {
			if (obj.hasOwnProperty(prop)) {
				if (typeof obj[prop]==="object"){
					recursiveClean(obj[prop]); // clean the contents of this object
					var json=JSON.stringify(obj[prop]);
					if (json==='{}' || json==='[]') { // if the object is now empty, remove it
						delete obj[prop];
					}
				}
				else if (true === obj[prop]) {
					obj[prop]=1;
				}
				else if (false === obj[prop]) {
					obj[prop]=0;
				}
				else if (null === obj[prop]) {
					delete obj[prop];
				}
				else if (0 && '' === obj[prop]) {
					delete obj[prop];
				}
			}
		}
	}
	recursiveClean(params);
	if (!fail) {
		fail=function(ret) {
			console.log('ERROR: '+JSON.stringify(ret));
		};
	}
	this.apiCalls.push([url, params, success, fail, action]);
	this.apiNext();
};
PhoneSync.prototype.apiAlreadyInQueue=function(name) {
	for (var i=0;i<this.apiCalls.length;++i) {
		if (this.apiCalls[i][4]===name) {
			return true;
		}
	}
};
PhoneSync.prototype.apiNext=function() {
	var that=this;
	if (navigator.connection.type===Connection.NONE) {
		return that.delayApiNext(5000);
	}
	clearTimeout(window.PhoneSync_timerApiCall);
	if (!that.apiCalls.length) {
		return;
	}
	if (that.networkInUse) {
		if (that.networkInUse>(new Date)) {
			return that.delayApiNext(1000);
		}
		that.networkInUse=false;
		return that.delayApiNext(1);
	}
	that.networkInUse=new Date;
	that.networkInUse.setSeconds(that.networkInUse.getSeconds()+240); // block the network for the next 240 seconds
	clearTimeout(window.PhoneSync_timersClearNetwork);
	that.options.onBeforeNetwork();
	var call=false;
	// { login/logout are priority
	for (var i=0;i<that.apiCalls.length;++i) {
		if (that.apiCalls[i][4]==='login' || that.apiCalls[i][4]==='logout') {
			call=that.apiCalls[i];
			that.apiCalls.splice(i, 1);
			//noinspection BreakStatementJS
		 break;
		}
	}
	// }
	if (!call) { // otherwise, uploads are priority
		for (i=0;i<this.apiCalls.length;++i) {
			if ('syncUploads' === this.apiCalls[i][4]) {
				call=this.apiCalls[i];
				this.apiCalls.splice(i, 1);
				//noinspection BreakStatementJS
			 break;
			}
		}
	}
	if (!call) { // else, just pick the first in the list
		call=this.apiCalls.shift();
	}
	var url=call[0], params=call[1], success=call[2], fail=call[3], action=call[4];
	that.mostRecentApiCallType=action;
	that.apiXHR=$.post(url, params)
		.done(function(ret) {
			that.options.onNetwork();
			if (!ret) {
				console.log('error while sending request', url, params, ret);
				that.options.errorHandler({'err':'error while sending request'});
			}
			else if (ret.error) {
				console.log('ERROR: '+JSON.stringify(ret), url, params, ret);
				if (that.options.errorHandler) {
					that.options.errorHandler(ret);
				}
			}
			else {
				if (action==='login') {
					that.loggedIn=true;
				}
				if (success) {
					success(ret);
				}
			}
		})
		.fail(function(ret) {
			that.apiCalls.push(call);
			fail();
		})
		.always(function() {
			that.networkInUse=false;
			window.clearTimeout(window.PhoneSync_timersClearNetwork);
			that.delayApiNext(1);
		});
};
PhoneSync.prototype.apiQueueClear=function(type) {
	if (type===undefined || type=='') {
		type='syncDownloads';
	}
	var that=this;
	if (that.apiXHR) {
		if (type=='all' || type==that.mostRecentApiCallType) {
			that.apiXHR.abort();
		}
	}
	var arr=[];
	for (var i=0;i<that.apiCalls.length;++i) {
		if (type=='all' || type==that.apiCalls[i][4]) {
			continue;
		}
		arr.push(that.apiCalls[i]);
	}
	that.apiCalls=arr;
	that.networkInUse=false;
	that.inSyncDownloads=false;
}
PhoneSync.prototype.dbSetupIndexedDB=function() {
	var that=this, dbreq=window.indexedDB.open(that.options.dbName, 3);
	dbreq.onsuccess=function(ev) {
		that.fs=ev.target.result;
		that.delaySyncDownloads();
		that.delaySyncUploads();
		that.get('_tables', function(ret) {
			if (null === ret) {
				return;
			}
			$.extend(that.tables, ret.obj);
		});
		that.get('_files', function(ret) {
			if (null === ret) {
				that.save({
					'key':'_files',
					'files':{'_files':1}
				}, null, true);
			}
		});
		that.options.ready(that);
	};
	dbreq.onupgradeneeded=function(e) {
		console.log('upgrading');
		that.fs=e.target.result;
		if (!that.fs.objectStoreNames.contains(that.options.dbName)) {
			that.fs.createObjectStore(that.options.dbName);
		}
	}
}
PhoneSync.prototype.delayAllowDownloads=function() {
	var that=this;
	that.allowDownloads=false;
	window.clearTimeout(window.PhoneSync_timerAllowDownloads);
	window.PhoneSync_timerAllowDownloads=window.setTimeout(function() {
		that.get('_syncUploads', function(obj) {
			if (!obj || obj===undefined || obj.keys.length==0) { // nothing to upload
				that.allowDownloads=true;
			}
			else {
				that.delayAllowDownloads();
			}
		});
	}, that.options.timeout);
}
PhoneSync.prototype.delayApiNext=function(delay) {
	var that=this;
	window.clearTimeout(window.PhoneSync_timerApiCall);
	window.PhoneSync_timerApiCall=window.setTimeout(function() {
		that.apiNext();
	}, delay||1000);
};
PhoneSync.prototype.delayFilePutJSON=function(delay) {
	var that=this;
	window.clearTimeout(window.PhoneSync_timerFilePutQueue);
	window.PhoneSync_timerFilePutQueue=window.setTimeout(function() {
		that.filePutJSON();
	}, delay||that.options.timeout);
};
PhoneSync.prototype.delayIdxPutJSON=function(delay) {
	var that=this;
	window.clearTimeout(window.PhoneSync_timerIdxPutQueue);
	window.PhoneSync_timerIdxPutQueue=window.setTimeout(function() {
		that.idxPutJSON();
	}, delay||that.options.timeout);
};
PhoneSync.prototype.delaySyncDownloads=function(delay) {
	var that=this;
	delay=delay||that.options.timeout;
	clearTimeout(window.PhoneSync_timerSyncDownloads);
	window.PhoneSync_timerSyncDownloads=setTimeout(function() {
		that.syncDownloads();
	}, delay);
}
PhoneSync.prototype.delaySyncUploads=function(delay) {
	var that=this;
	window.clearTimeout(window.PhoneSync_timerSyncUploads);
	window.PhoneSync_timerSyncUploads=setTimeout(function() {
		that.syncUploads();
	}, delay||that.options.timeout);
};
PhoneSync.prototype.delete=function(key, callback) {
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
	if ('indexeddb' === that.options.dbType) {
		var txn=that.fs.transaction([that.options.dbName], 'readwrite');
		if (txn) {
			var store=txn.objectStore(that.options.dbName);
			store.delete(key);
			store.onsuccess=function(ev) {
				that.get('_files', function(ret) {
					if (ret===null) {
						return;
					}
					if (ret.files[key]) {
						delete ret.files[key];
						that.save(ret, null, true);
					}
				});
			};
		}
		else {
			console.log('could not open indexeddb transaction');
		}
	}
	else if ('files' === that.options.dbType) {
		that.fs.getFile(key, {create: false, exclusive: false}, function(file) {
			file.remove();
			that.get('_files', function(ret) {
				if (ret===null) {
					return;
				}
				if (ret.files[key]) {
					delete ret.files[key];
					that.save(ret, null, true);
				}
			});
		});
	}
	else {
		that.get('_files', function(ret) {
			if (ret===null) {
				return;
			}
			if (ret.files[key]) {
				delete ret.files[key];
				that.save(ret);
			}
		});
	}
	this.options.onDelete(key);
};
PhoneSync.prototype.fileGetJSON=function(name, success, fail) {
	var that=this;
	if (this.disableFS) {
		return;
	}
	if (!this.fs) {
		return window.setTimeout(function() {
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
							success(JSON.parse(
								evt.target.result
									.replace(/,\\*"[^"]*":\[\]/, '')
									.replace(/\\*"[^"]*":\[\],/, '')
									.replace(/[\u2018\u2019]/g, "'")
									.replace(/[\u201C\u201D]/g, '\\"')
							));
						}
						else {
							fail();
						}
					};
					reader.readAsText(file);
				},
				fail
			);
		},
		fail
	);
};
PhoneSync.prototype.filePutJSON=function(name, obj, callback) {
	var that=this;
	if (that.disableFS || 'none'===that.options.dbType) {
		return callback?callback():0;
	}
	// { if a file is submitted, queue it and come back later
	if (name && obj) {
		for (var i=1;i<that.filePutQueue.length;++i) { // if the file is already in the queue, remove the old copy as it is out of date
			var f=that.filePutQueue[i];
			if (f[0]===name) {
				that.filePutQueue.splice(i, 1);
				//noinspection BreakStatementJS
			 break;
			}
		}
		that.filePutQueue.push([name, obj, callback]);
		return that.delayFilePutJSON(1);
	}
	// }
	// { if a file is currently being written, then come back later
	if (that.filePutJSONLock) {
		return that.delayFilePutJSON(1);
	}
	// }
	// { write a file
	that.filePutJSONLock=true;
	var o=that.filePutQueue.shift();
	if (o) {
		name=o[0];
		obj=o[1];
		callback=o[2];
		var json=JSON.stringify(obj);
		that.fs.getFile(that.sanitise(name), {'create':true, 'exclusive':false},
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
								that.delayFilePutJSON(1);
							}
						};
						writer.write(json);
					},
					function(err) { // failed to create writer
						console.log('ERROR', 'failed to create writer', err);
						that.filePutQueue.unshift(o);
						that.delayFilePutJSON();
					});
			}
		);
	}
	else {
		if (that.filePutQueue.length) {
			that.delayFilePutJSON(1);
		}
	}
	// }
};
PhoneSync.prototype.get=function(key, callback, download, failcallback) {
	if (!callback) {
		callback=function() {};
	}
	function doTheGet(rekeys) {
		if (!(undefined===rekeys || null === rekeys) && rekeys.changes && rekeys.changes[key]) {
			key=rekeys.changes[key];
		}
		if (that.cache._files) {
			if (that.cache._files.files[key]===undefined && (undefined===download || !download)) {
				if ('_rekeys' === key) {
					var rekeys={
						'key':'_rekeys',
						'changes':{}
					};
					lch.save(rekeys, null, true);
					callback(rekeys);
					return rekeys;
				}
				return fail();
			}
		}
		for (var i=0;i<that.fileGetQueue.length;++i) {
			if (that.fileGetQueue[i]===key) {
				//noinspection JSHint
				return setTimeout(function() {
					that.get(key, callback, download);
				}, 1);
			}
		}
		that.fileGetQueue.push(key);
		if (that.options.dbType=='file') {
			that.fileGetJSON(key,
				function(obj) {
					var arr=[];
					for (var i=0;i<that.fileGetQueue.length;++i) {
						if (that.fileGetQueue[i]!==key) {
							arr.push(that.fileGetQueue[i]);
						}
					}
					that.fileGetQueue=arr;
					that.cache[key]=obj;
					callback($.extend({}, obj));
				},
				function() {
					if (download) {
						if (that.inSyncDownloads) {
							that.inSyncDownloads=false;
							that.networkInUse=false;
							that.apiXHR.abort();
						}
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
		else if (that.options.dbType=='indexeddb') {
			function fail2() {
				if (download) {
					if (that.inSyncDownloads) {
						that.inSyncDownloads=false;
						that.networkInUse=false;
						that.apiXHR.abort();
					}
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
			that.idxGetJSON(
				key,
				function(obj) {
					if (obj===undefined) {
						return fail2();
					}
					var arr=[];
					for (var i=0;i<that.fileGetQueue.length;++i) {
						if (that.fileGetQueue[i]!==key) {
							arr.push(that.fileGetQueue[i]);
						}
					}
					that.fileGetQueue=arr;
					that.cache[key]=obj;
					callback($.extend({}, obj));
				},
				fail2
			);
		}
	}
	function fail() {
		if (failcallback) {
			failcallback();
		}
		var arr=[];
		for (var i=0;i<that.fileGetQueue.length;++i) {
			if (that.fileGetQueue[i]!==key) {
				arr.push(that.fileGetQueue[i]);
			}
		}
		that.fileGetQueue=arr;
		callback(null);
	}
	var that=this;
	if (this.disableFS) {
		return;
	}
	if (this.cache[key]) {
		if (!(this.cache[key]===null && download)) {
			return callback($.extend({}, this.cache[key]));
		}
	}
	if ('_rekeys' === key) {
		doTheGet(null);
	}
	else {
		that.get('_rekeys', doTheGet, false, function() {
			obj={
				'key':'_rekeys',
				'changes':{}
			};
			lch.save(obj, false, true);
		});
	}
};
PhoneSync.prototype.getAll=function(key, callback) {
	var that=this;
	if (this.disableFS) {
		return;
	}
	var keys=[];
	if (this.cache[key]) {
		keys=this.cache[key].obj;
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
	function getObject(ret) {
		rows.push($.extend({}, ret));
		toGet--;
		if (!toGet) {
			callback(rows);
		}
	}
	for (var i=0;i<keys.length;++i) {
		this.get(key+'-'+keys[i], getObject);
	}
};
PhoneSync.prototype.getAllById=function(keys, callback) {
	if (this.disableFS) {
		return;
	}
	var rows=[];
	var toGet=keys.length;
	function getObject(ret) {
		if (ret!==null) {
			rows.push($.extend({}, ret));
		}
		toGet--;
		if (!toGet) {
			callback(rows);
		}
	}
	for (var i=0;i<keys.length;++i) {
		this.get(keys[i], getObject);
	}
};
PhoneSync.prototype.getSome=function(keys, callback) {
	var toGet=keys.length, vals=[];
	for (var i=0;i<keys.length;++i) {
		lch.get(keys[i], function(ret) {
			vals.push(ret);
			toGet--;
			if (!toGet) {
				callback(vals);
			}
		});
	}
}
PhoneSync.prototype.idAdd=function(name, id, callback) {
	var that=this;
	id=''+id;
	this.get(name, function(ret) {
		if (!ret || !ret.obj) {
			ret={'obj':[]};
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
				setZeroTimeout(callback);
			}
		}
	});
};
PhoneSync.prototype.idDel=function(name, id) {
	var that=this;
	id=''+id;
	this.get(name, function(ret) {
		ret=ret||{'obj':[]};
		var arr=[];
		if (ret.obj) {
			for (var i=0;i<ret.obj.length;++i) {
				if (id !== ret.obj[i]) {
					arr.push(ret.obj[i]);
				}
			}
		}
		that.save({
			'key':name,
			'obj':arr,
			'id':id // added to let recursive idAdd work
		}, false, true);
	});
};
PhoneSync.prototype.idxPutJSON=function(name, obj, callback) {
	var that=this;
	if (that.disableFS || 'none'===that.options.dbType) {
		return callback?callback():0;
	}
	// { if a file is submitted, queue it and come back later
	if (name && obj) {
		for (var i=1;i<that.filePutQueue.length;++i) { // if the file is already in the queue, remove the old copy as it is out of date
			var f=that.filePutQueue[i];
			if (f[0]===name) {
				that.filePutQueue.splice(i, 1);
				//noinspection BreakStatementJS
			 break;
			}
		}
		that.filePutQueue.push([name, obj, callback]);
		return that.delayIdxPutJSON(1);
	}
	// }
	// { if a file is currently being written, then come back later
	if (that.idxPutJSONLock) {
		return that.delayIdxPutJSON(1);
	}
	// }
	// { write a file
	that.idxPutJSONLock=true;
	var o=that.filePutQueue.shift();
	if (o) {
		name=o[0];
		obj=o[1];
		callback=o[2];

		var txn=that.fs.transaction([that.options.dbName], 'readwrite');
		var store=txn.objectStore(that.options.dbName);
		txn.onerror=function(e) {
			console.log('ERROR', 'failed to create file', e);
			that.filePutQueue.unshift(o);
			that.delayIdxPutJSON();
		}
		txn.oncomplete=function() {
			if (callback) {
				callback();
			}
			if (name!=='_files') {
				that.get('_files', function(ret) {
					if (ret===null || ret.files===undefined) {
						ret={
							'key':'_files',
							'files':{'_files':1}
						};
					}
					if (ret.files[name]===undefined) {
						ret.files[name]=1;
						setZeroTimeout(function() {
							that.save(ret, null, true);
						});
					}
				});
			}
			that.idxPutJSONLock=false;
			if (that.filePutQueue.length) {
				that.delayIdxPutJSON(1);
			}
		}
		store.put(obj, name);
	}
	else {
		if (that.filePutQueue.length) {
			that.delayIdxPutJSON(1);
		}
	}
	// }
};
PhoneSync.prototype.idxGetJSON=function(name, success, fail) {
	var that=this;
	if (this.disableFS) {
		return;
	}
	if (!this.fs) {
		return window.setTimeout(function() {
			that.idxGetJSON(name, success, fail);
		}, that.options.timeout);
	}
	var txn=that.fs.transaction([that.options.dbName]);
	if (txn) {
		var store=txn.objectStore(that.options.dbName);
		var ob=store.get(name);
		ob.onsuccess=function(ev) {
			if (ob.result===undefined) {
				ob.result=null;
			}
			success(ob.result);
		};
		ob.fail=function() {
			fail();
		}
	}
	else {
		console.log('could not open indexeddb transaction');
	}
};
PhoneSync.prototype.nuke=function(callback) {
	var that=this;
	if (that.options.dbType=='file') {
		that.disableFS=true;
		try {
			that.fs.removeRecursively(function() {
				console.log('successfully nuked. rebuilding now.');
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
									that.delaySyncDownloads();
									that.delaySyncUploads();
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
	}
	else if (that.options.dbType=='indexeddb') {
		that.disableFS=true;
		console.log('okay - about to request the deletion');
		var req=indexedDB.deleteDatabase(that.options.dbName);
		req.onerror=function() {
			console.log('failed to nuke');
		}
		if (callback) {
			callback();
		}
	}
	else {
		if (callback) {
			callback();
		}
	}
	that.tablesLastUpdateClear();
	that.alreadyDoingSyncUpload=0;
	that.cache={};
};
PhoneSync.prototype.rekey=function(table, oldId, newId, callback) {
	var that=this;
	if (oldId==newId) {
		return;
	}
	this.get('_rekeys', function(obj) {
		if (null === obj) {
			obj={
				'key':'_rekeys',
				'changes':{}
			};
		}
		obj.changes[table+'-'+oldId]=table+'-'+newId;
		lch.save(obj, null, true);
	});
	this.get(table+'-'+oldId, function(obj) {
		obj.key=table+'-'+newId;
		obj.obj.id=newId;
		that.save(obj, callback, true);
		that.delete(table+'-'+oldId);
	});
};
PhoneSync.prototype.sanitise=function(name) {
	return name.replace(/[^a-zA-Z0-9\-]/g, '');
};
PhoneSync.prototype.save=function(obj, callback, nosync) {
	var that=this;
	that.options.onBeforeSave(obj.key, obj);
	function onSave() {
		that.options.onSave(obj.key, obj);
	}
	if (that.disableFS) {
		return;
	}
	that.cache[obj.key]=obj;
	var id=obj.obj && obj.obj.id ? obj.obj.id : obj.id;
	if (/-/.test(obj.key) && id) {
		that.idAdd(obj.key.replace(/-[^-]*$/, ''), id, function() {
			if (callback) {
				setZeroTimeout(callback);
			}
			if (!(nosync || /^_/.test(obj.key))) {
				that.addToSyncUploads(obj.key);
			}
			if (that.options.dbType=='file') {
				that.filePutJSON(obj.key, obj, onSave);
			}
			else if (that.options.dbType=='indexeddb') {
				that.idxPutJSON(obj.key, obj, onSave);
			}
		});
	}
	else {
		if (callback) {
			setZeroTimeout(callback);
		}
		if (!nosync) {
			that.addToSyncUploads(obj.key);
		}
		if (that.options.dbType=='file') {
			that.filePutJSON(obj.key, obj, onSave);
		}
		else if (that.options.dbType=='indexeddb') {
			that.idxPutJSON(obj.key, obj, onSave);
		}
	}
};
PhoneSync.prototype.syncDownloads=function() {
	var that=this;
	if (!that.allowDownloads || !window.credentials || that.inSyncDownloads) {
		return that.delaySyncDownloads();
	}
	if (that.apiAlreadyInQueue('syncDownloads')) {
		return;
	}
	if (that.disableFS) {
		console.log('fs disabled');
		return;
	}
	if (!that.loggedIn) {
		return that.delaySyncDownloads(15000);
	}
	that.inSyncDownloads=true;
	clearTimeout(window.PhoneSync_timerSyncDownloads);
	that.api(
		'syncDownloads', {},
		function(ret) {
			// { relink headers and values if headers and values are separate
			$.each(ret, function(k, v) {
				var headers=v[0], vals=[];
				if (!$.isArray(headers)) {
					return;
				}
				for (var i=0;i<v[1].length;++i) {
					var obj={};
					for (var j=0;j<headers.length;++j) {
						obj[headers[j]]=v[1][i][j];
					}
					vals.push(obj);
				}
				ret[k]=vals;
			});
			// }
			var changes=0;
			// handle deletes first
			$.each(ret, function(k, v) {
				if (k!=='_deletes') {
					return;
				}
				if (!$.isArray(v)) {
					return;
				}
				var deletes=v;
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
				}
				if (tableUpdatesChanged) {
					that.save( { 'key':'_tables', 'obj':that.tables }, false, true);
				}
				for (var i=0;i<deletes.length;++i) {
					if (deletes[i].key===undefined) {
						deletes[i].key=deletes[i].table_name+'-'+deletes[i].item_id;
					}
					that.delete(deletes[i].key);
					changes++;
				}
			});
			// then do the rest
			var tablesToDo=0;
			$.each(ret, function(k, v) {
				tablesToDo++;
				if (!$.isArray(v) || k=='_deletes') {
					tablesToDo--;
					return;
				}
				var tableUpdatesChanged=false;
				var i=0;
				function next() {
					if (i==v.length) {
						if (tableUpdatesChanged) {
							that.save( { 'key':'_tables', 'obj':that.tables }, false, true);
						}
						tablesToDo--;
						if (!tablesToDo) {
							that.inSyncDownloads=false;
							that.delaySyncDownloads(changes?100:that.options.syncDownloadsTimeout)
						}
						return;
					}
					var obj=v[i];
					i++;
					if (obj===null) {
						return setZeroTimeout(next);
					}
					if (!that.tables[k].lastUpdate
						|| obj.last_edited>that.tables[k].lastUpdate
						) {
						that.tables[k].lastUpdate=obj.last_edited;
						tableUpdatesChanged=true;
						changes++;
					}
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
									}, next, true);
									that.options.onUpdate(k+'-'+obj.id, obj);
								}
								else setZeroTimeout(next);
							}
							else { // created somewhere else
								that.save({
									'key':k+'-'+obj.id,
									'obj':obj
								}, next, true);
								that.options.onUpdate(k+'-'+obj.id, obj);
							}
						});
					})(k, obj);
				}
				next();
			});
			if (!tablesToDo) {
				that.inSyncDownloads=false;
				that.delaySyncDownloads(changes?100:that.options.syncDownloadsTimeout)
			}
		},
		function(err) {
			that.inSyncDownloads=false;
			that.delaySyncDownloads(that.options.syncDownloadsTimeout);
		}
	);
};
PhoneSync.prototype.syncUploads=function() {
	var that=this;
	if (!that.loggedIn || !window.credentials) {
		return that.delaySyncUploads(5000);
	}
	if (that.apiAlreadyInQueue('syncUploads')) {
		return;
	}
	if (that.alreadyDoingSyncUpload) {
		return that.delaySyncUploads(1);
	}
	if (that.inSyncDownloads) {
		that.apiQueueClear('syncDownloads');
	}
	var numberOfUploads=++that.numberOfUploads;
	if (that.disableFS) {
		return;
	}
	that.get('_syncUploads', function(obj) {
		if (!obj || obj===undefined || obj.keys===undefined || obj.keys.length==0) { // nothing to upload
			that.delaySyncDownloads();
			return;
		}
		var key=obj.keys[0];
		that.delayAllowDownloads();
		if (/^_/.test(key)) { // items beginning with _ should not be uploaded
			obj.keys.shift();
			return that.save(obj, function() {
				that.delaySyncUploads(1);
			}, true);
		}
		if (that.alreadyDoingSyncUpload) {
			return that.delaySyncUploads(1);
		}
		that.alreadyDoingSyncUpload=1;
		that.get(key, function(ret) {
			if (ret===null) { // item does not exist. remove from queue
				console.log('object did not exist. removing.');
				obj.keys.shift();
				return that.save(obj, function() {
					console.log('removed.');
					that.alreadyDoingSyncUpload=0;
					that.delaySyncUploads(1);
				}, true);
			}
			if (that.inSyncDownloads) {
				that.inSyncDownloads=false;
				that.networkInUse=false;
				that.apiXHR.abort();
			}
			window.syncUploadsClearTimeout=setTimeout(function() {
				that.alreadyDoingSyncUpload=0;
			}, 60000);
			that.api(
				'syncUploads', {
					'key':ret.key,
					'obj':JSON.stringify(ret.obj)
				},
				function(ret) { //  success
					clearTimeout(window.syncUploadsClearTimeout);
					if (obj.keys[0]!==key) {
						console.warn('DUPLICATE UPLOADED?? '+key);
						that.delaySyncUploads(1);
						that.alreadyDoingSyncUpload=0;
						return;
					}
					that.alreadyDoingSyncUpload=0;
					obj.keys.shift();
					that.save(obj, function() { // remove that item from the queue
						that.delaySyncUploads(1);
						that.delaySyncDownloads();
						if (ret) {
							that.options.onUpload(key, ret);
						}
					}, true);
				},
				function(err) { // fail
					window.syncUploadsClearTimeout;
					console.log('upload failed');
					that.alreadyDoingSyncUpload=0;
					that.delaySyncUploads();
					that.delaySyncDownloads();
				}
			);
		});
	});
};
PhoneSync.prototype.tablesLastUpdateClear=function() {
	for (var i=0;i<this.options.tables.length;++i) {
		this.tables[this.options.tables[i]]={
			'lastUpdate':'0000-00-00 00:00:00'
		}
	}
};
var setZeroTimeout=function(a){if(a.postMessage){var b=[],c="asc0tmot",d=function(a){b.push(a),postMessage(c,"*")},e=function(d){if(d.source==a&&d.data==c){d.stopPropagation&&d.stopPropagation();if(b.length)try{b.shift()()}catch(e){setTimeout(function(a){return function(){throw a.stack||a}}(e),0)}b.length&&postMessage(c,"*")}};if(a.addEventListener)return addEventListener("message",e,!0),d;if(a.attachEvent)return attachEvent("onmessage",e),d}return setTimeout}(window);
