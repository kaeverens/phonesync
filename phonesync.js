if (!window.setZeroTimeout) {
	window.setZeroTimeout=function(a){if(a.postMessage){var b=[],c="asc0tmot",d=function(a){b.push(a),postMessage(c,"*")},e=function(d){if(d.source==a&&d.data==c){d.stopPropagation&&d.stopPropagation();if(b.length)try{b.shift()()}catch(e){setTimeout(function(a){return function(){throw a.stack||a}}(e),0)}b.length&&postMessage(c,"*")}};if(a.addEventListener)return addEventListener("message",e,!0),d;if(a.attachEvent)return attachEvent("onmessage",e),d}return setTimeout}(window);
}
window.PhoneSync=function(params) {
	PhoneSync_Instance=this;
	if (!window.Connection) {
		window.Connection={
			'NONE':0
		};
	}
	PhoneSync_Instance.options={
		'dbName':'tmp',
		'dbType':params.dbType || (/http/.test(document.location.toString())?'indexeddb':'file'),
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
	$.extend(PhoneSync_Instance.options, params);
	PhoneSync_Instance.fs=false;
	PhoneSync_Instance.numberOfUploads=0;
	PhoneSync_Instance.allowDownloads=true; // don't allow downloads to happen while uploads are pending
	PhoneSync_Instance.disableFS=false;
	PhoneSync_Instance.filePutQueue=[];
	PhoneSync_Instance.fileGetQueue=[];
	PhoneSync_Instance.networkInUse=false;
	PhoneSync_Instance.loggedIn=false;
	PhoneSync_Instance.tables={};
	PhoneSync_Instance.cache={};
	PhoneSync_Instance.apiCalls=[];
	PhoneSync_Instance.tablesLastUpdateClear();
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
	if (PhoneSync_Instance.options.dbType=='file') {
		window.requestFileSystem(
			LocalFileSystem.PERSISTENT, 0,
			function(filesystem) {
				console.log(filesystem);
				var entry=filesystem.root;
				entry.getDirectory(PhoneSync_Instance.options.dbName,
					{'create':true, 'exclusive':false},
					function(root) {
						PhoneSync_Instance.fs=root;
						PhoneSync_Instance.delaySyncDownloads();
						PhoneSync_Instance.delaySyncUploads();
						PhoneSync_Instance.get('_tables', function(ret) {
							if (null === ret) {
								return;
							}
							$.extend(PhoneSync_Instance.tables, ret.obj);
						});
						PhoneSync_Instance.get('_files', function(ret) {
							if (null === ret) {
								PhoneSync_Instance.save({
									'key':'_files',
									'files':{'_files':1}
								}, null, true);
							}
						});
						PhoneSync_Instance.options.ready(PhoneSync_Instance);
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
					},
					function(err) {
						console.log(err);
					}
				);
			},
			null
		);
	}
	else if (PhoneSync_Instance.options.dbType=='indexeddb') {
		try {
			PhoneSync_Instance.dbSetupIndexedDB();
		}
		catch (e) {
			console.log(e);
		}
	}
	else {
		PhoneSync_Instance.save({
			'key':'_files',
			'files':{'_files':1}
		}, null, true);
		setTimeout(function() {
			PhoneSync_Instance.options.ready(PhoneSync_Instance);
			$(document).trigger('online');
		}, 1);
	}
	$(document).bind('online', function() {
		PhoneSync_Instance.delaySyncDownloads();
		PhoneSync_Instance.delaySyncUploads();
	});
	setInterval(function() {
		console.log('triggering uploads/downloads just in case');
		PhoneSync_Instance.delaySyncUploads();
		PhoneSync_Instance.delaySyncDownloads();
	}, 60000);
};
PhoneSync.prototype.addToSyncUploads=function(key) {
	PhoneSync_Instance.get('_syncUploads', function(ret) {
		if (!ret || ret===undefined || ret.keys===undefined) {
			ret={
				'key':'_syncUploads',
				'keys':[]
			};
		}
		if (0 < $.inArray(key, ret.keys, 1)) {
			return;
		}
		ret.keys.push(key);
		PhoneSync_Instance.save(ret, false, true);
	});
	PhoneSync_Instance.delaySyncUploads();
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
	if (PhoneSync_Instance.options.urls[action]===undefined) {
		console.log('no url defined for the action', action);
		fail();
		return;
	}
	var url=PhoneSync_Instance.options.urls[action];
	if ('syncDownloads' === action) {
		var lastUpdates={};
		$.each(PhoneSync_Instance.tables, function(k, v) {
			lastUpdates[k]='0000-00-00 00:00:00' === v.lastUpdate ? 0 : v.lastUpdate;
		});
		params._lastUpdates=lastUpdates;
	}
	if (PhoneSync_Instance.options.version) {
		params._v=PhoneSync_Instance.options.version;
	}
	params._uuid=(window.device&&device.uuid)?device.uuid:'no-uid|'+uid;
	PhoneSync_Instance.uuid=params._uuid;
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
	PhoneSync_Instance.apiCalls.push([url, params, success, fail, action]);
	PhoneSync_Instance.apiNext();
};
PhoneSync.prototype.apiAlreadyInQueue=function(name) {
	for (var i=0;i<PhoneSync_Instance.apiCalls.length;++i) {
		if (PhoneSync_Instance.apiCalls[i][4]===name) {
			return true;
		}
	}
};
PhoneSync.prototype.apiNext=function() {
	if (navigator.connection.type===Connection.NONE) {
		return PhoneSync_Instance.delayApiNext(5000);
	}
	clearTimeout(window.PhoneSync_timerApiCall);
	if (!PhoneSync_Instance.apiCalls.length) {
		return;
	}
	if (PhoneSync_Instance.networkInUse) {
		if (PhoneSync_Instance.networkInUse>(new Date())) {
			return PhoneSync_Instance.delayApiNext(1000);
		}
		PhoneSync_Instance.networkInUse=false;
		return PhoneSync_Instance.delayApiNext(1);
	}
	PhoneSync_Instance.networkInUse=new Date();
	PhoneSync_Instance.networkInUse.setSeconds(PhoneSync_Instance.networkInUse.getSeconds()+240); // block the network for the next 240 seconds
	PhoneSync_Instance.options.onBeforeNetwork();
	var call=false;
	// { login/logout are priority
	for (var i=0;i<PhoneSync_Instance.apiCalls.length;++i) {
		if (PhoneSync_Instance.apiCalls[i][4]==='login' || PhoneSync_Instance.apiCalls[i][4]==='logout') {
			call=PhoneSync_Instance.apiCalls[i];
			PhoneSync_Instance.apiCalls.splice(i, 1);
			break;
		}
	}
	// }
	// { followed by uploads
	if (!call) {
		for (i=0;i<PhoneSync_Instance.apiCalls.length;++i) {
			if ('syncUploads' === PhoneSync_Instance.apiCalls[i][4]) {
				call=PhoneSync_Instance.apiCalls[i];
				PhoneSync_Instance.apiCalls.splice(i, 1);
				break;
			}
		}
	}
	// }
	// { followed by downloadSome
	if (!call) {
		for (i=0;i<PhoneSync_Instance.apiCalls.length;++i) {
			if ('syncDownloadSome' === PhoneSync_Instance.apiCalls[i][4]) {
				call=PhoneSync_Instance.apiCalls[i];
				PhoneSync_Instance.apiCalls.splice(i, 1);
				break;
			}
		}
	}
	// }
	// { followed by anything else
	if (!call) {
		call=PhoneSync_Instance.apiCalls.shift();
	}
	// }
	var url=call[0], params=call[1], success=call[2], fail=call[3], action=call[4];
	if (window.device) {
		params._platform=window.device.platform;
		params._make=window.device.manufacturer;
		params._model=window.device.model;
	}
	PhoneSync_Instance.mostRecentApiCallType=action;
	PhoneSync_Instance.apiXHR=$.post(url, params)
		.done(function(ret) {
			PhoneSync_Instance.options.onNetwork();
			if (!ret) {
				console.log('error while sending request', url, params, ret);
				PhoneSync_Instance.options.errorHandler({'err':'error while sending request'});
			}
			else if (ret.error) {
				console.log('ERROR: '+JSON.stringify(ret), url, params, ret);
				if (PhoneSync_Instance.options.errorHandler) {
					PhoneSync_Instance.options.errorHandler(ret);
				}
			}
			else {
				if (action==='login') {
					PhoneSync_Instance.loggedIn=true;
				}
				if (success) {
					success(ret);
				}
			}
		})
		.fail(function(ret) {
			PhoneSync_Instance.apiCalls.push(call);
			fail();
		})
		.always(function() {
			PhoneSync_Instance.networkInUse=false;
			PhoneSync_Instance.delayApiNext(1);
		});
};
PhoneSync.prototype.apiQueueClear=function(type) {
	if (type===undefined || type==='') {
		type='syncDownloads';
	}
	
	if (PhoneSync_Instance.apiXHR) {
		if (type=='all' || type==PhoneSync_Instance.mostRecentApiCallType) {
			PhoneSync_Instance.apiXHR.abort();
		}
	}
	var arr=[];
	for (var i=0;i<PhoneSync_Instance.apiCalls.length;++i) {
		if (type=='all' || type==PhoneSync_Instance.apiCalls[i][4]) {
			continue;
		}
		arr.push(PhoneSync_Instance.apiCalls[i]);
	}
	PhoneSync_Instance.apiCalls=arr;
	PhoneSync_Instance.networkInUse=false;
	PhoneSync_Instance.inSyncDownloads=false;
};
PhoneSync.prototype.dbSetupIndexedDB=function() {
	var dbreq=window.indexedDB.open(PhoneSync_Instance.options.dbName, 3);
	dbreq.onsuccess=function(ev) {
		PhoneSync_Instance.fs=ev.target.result;
		PhoneSync_Instance.delaySyncDownloads();
		PhoneSync_Instance.delaySyncUploads();
		PhoneSync_Instance.get('_tables', function(ret) {
			if (null === ret) {
				return;
			}
			$.extend(PhoneSync_Instance.tables, ret.obj);
		});
		PhoneSync_Instance.get('_files', function(ret) {
			if (null === ret) {
				PhoneSync_Instance.save({
					'key':'_files',
					'files':{'_files':1}
				}, null, true);
			}
		});
		PhoneSync_Instance.options.ready(PhoneSync_Instance);
	};
	dbreq.onupgradeneeded=function(e) {
		console.log('upgrading');
		PhoneSync_Instance.fs=e.target.result;
		if (!PhoneSync_Instance.fs.objectStoreNames.contains(PhoneSync_Instance.options.dbName)) {
			PhoneSync_Instance.fs.createObjectStore(PhoneSync_Instance.options.dbName);
		}
	};
};
PhoneSync.prototype.delayAllowDownloads=function() {
	PhoneSync_Instance.allowDownloads=false;
	window.clearTimeout(window.PhoneSync_timerAllowDownloads);
	PhoneSync_timerAllowDownloads=window.setTimeout(function() {
		PhoneSync_Instance.get('_syncUploads', function(obj) {
			if (!obj || obj===undefined || obj.keys===undefined || obj.keys.length===0) { // nothing to upload
				PhoneSync_Instance.allowDownloads=true;
			}
			else {
				PhoneSync_Instance.delayAllowDownloads();
			}
		});
	}, PhoneSync_Instance.options.timeout);
};
PhoneSync.prototype.delayApiNext=function(delay) {
	window.clearTimeout(window.PhoneSync_timerApiCall);
	PhoneSync_timerApiCall=window.setTimeout(function() {
		PhoneSync_Instance.apiNext();
	}, delay||1000);
};
PhoneSync.prototype.delayFilePutJSON=function(delay) {
	window.clearTimeout(window.PhoneSync_timerFilePutQueue);
	PhoneSync_timerFilePutQueue=window.setTimeout(function() {
		PhoneSync_Instance.filePutJSON();
	}, delay||PhoneSync_Instance.options.timeout);
};
PhoneSync.prototype.delayIdxPutJSON=function(delay) {
	window.clearTimeout(window.PhoneSync_timerIdxPutQueue);
	PhoneSync_timerIdxPutQueue=window.setTimeout(function() {
		PhoneSync_Instance.idxPutJSON();
	}, delay||PhoneSync_Instance.options.timeout);
};
PhoneSync.prototype.delaySyncDownloads=function(delay) {
	delay=delay||PhoneSync_Instance.options.timeout;
	clearTimeout(window.PhoneSync_timerSyncDownloads);
	PhoneSync_timerSyncDownloads=setTimeout(function() {
		PhoneSync_Instance.syncDownloads();
	}, delay);
};
PhoneSync.prototype.delaySyncUploads=function(delay) {
	window.clearTimeout(window.PhoneSync_timerSyncUploads);
	PhoneSync_timerSyncUploads=setTimeout(function() {
		PhoneSync_Instance.syncUploads();
	}, delay||PhoneSync_Instance.options.timeout);
};
PhoneSync.prototype.delete=function(key, callback) {
	if (PhoneSync_Instance.disableFS) {
		return;
	}
	delete PhoneSync_Instance.cache[key];
	if (/-/.test(key)) {
		PhoneSync_Instance.idDel(key.replace(/-[^-]*$/, ''), key.replace(/.*-/, ''));
	}
	if (callback) {
		callback();
	}
	if ('indexeddb' === PhoneSync_Instance.options.dbType) {
		var txn=PhoneSync_Instance.fs.transaction([PhoneSync_Instance.options.dbName], 'readwrite');
		if (txn) {
			var store=txn.objectStore(PhoneSync_Instance.options.dbName);
			store.delete(key);
			store.onsuccess=function(ev) {
				PhoneSync_Instance.get('_files', function(ret) {
					if (ret===null) {
						return;
					}
					if (ret.files[key]) {
						delete ret.files[key];
						PhoneSync_Instance.save(ret, null, true);
					}
				});
			};
		}
		else {
			console.log('could not open indexeddb transaction');
		}
	}
	else if ('files' === PhoneSync_Instance.options.dbType) {
		PhoneSync_Instance.fs.getFile(key, {create: false, exclusive: false}, function(file) {
			file.remove();
			PhoneSync_Instance.get('_files', function(ret) {
				if (ret===null) {
					return;
				}
				if (ret.files[key]) {
					delete ret.files[key];
					PhoneSync_Instance.save(ret, null, true);
				}
			});
		});
	}
	else {
		PhoneSync_Instance.get('_files', function(ret) {
			if (ret===null) {
				return;
			}
			if (ret.files[key]) {
				delete ret.files[key];
				PhoneSync_Instance.save(ret, null, true);
			}
		});
	}
	PhoneSync_Instance.options.onDelete(key);
};
PhoneSync.prototype.fileGetJSON=function(name, success, fail) {
	if (PhoneSync_Instance.disableFS) {
		return;
	}
	if (!PhoneSync_Instance.fs || PhoneSync_Instance.fileLock) {
		return window.setTimeout(function() {
			PhoneSync_Instance.fileGetJSON(name, success, fail);
		}, PhoneSync_Instance.options.timeout);
	}
	PhoneSync_Instance.fs.getFile(PhoneSync_Instance.sanitise(name), {'create':false, 'exclusive':false},
		function(entry) {
			entry.file(
				function(file) {
					var reader=new FileReader();
					PhoneSync_Instance.fileLock=true;
					reader.onloadend=function(evt) {
						PhoneSync_Instance.fileLock=false;
						if (evt.target.result) {
							var res=evt.target.result, obj;
							var res2=res
								.replace(/,\\*"[^"]*":\[\]/, '')
								.replace(/\\*"[^"]*":\[\],/, '')
								.replace(/[\u2018\u2019]/g, "'")
								.replace(/[\u201C\u201D]/g, '\\"');
							try{
								obj=JSON.parse(res);
							}
							catch (e) {
								console.warn('failed to decode file! will try again in a moment');
								console.warn(e, res);
								return setTimeout(function() {
									PhoneSync.prototype.fileGetJSON(name, success, fail);
								}, 2000);
							}
							success(obj);
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
PhoneSync.prototype.filePutJSON=function(name, obj) {
	var f;
	if (PhoneSync_Instance.disableFS || 'none'===PhoneSync_Instance.options.dbType) {
		return PhoneSync_Instance.options.onSave?PhoneSync_Instance.options.onSave(name, obj):0;
	}
	// { if a file is submitted, queue it and come back later
	if (name && obj) {
		for (var i=1;i<PhoneSync_Instance.filePutQueue.length;++i) { // if the file is already in the queue, remove the old copy as it is out of date
			f=PhoneSync_Instance.filePutQueue[i];
			if (f[0]===name) {
				PhoneSync_Instance.filePutQueue.splice(i, 1);
			 break;
			}
		}
		PhoneSync_Instance.filePutQueue.push([name, obj]);
		return PhoneSync_Instance.delayFilePutJSON(1);
	}
	// }
	// { if a file is currently being written, then come back later
	if (PhoneSync_Instance.fileLock) {
		return PhoneSync_Instance.delayFilePutJSON(1);
	}
	// }
	// { write a file
	PhoneSync_Instance.fileLock=true;
	PhoneSync_Instance.currentFilePutFile=PhoneSync_Instance.filePutQueue.shift();
	if (PhoneSync_Instance.currentFilePutFile) {
		name=PhoneSync_Instance.currentFilePutFile[0];
		obj=PhoneSync_Instance.currentFilePutFile[1];
		var json=JSON.stringify(obj);
		PhoneSync_Instance.fs.getFile(PhoneSync_Instance.sanitise(name), {'create':true, 'exclusive':false},
			function(entry) {
				entry.createWriter(
					function(writer) {
						writer.onwriteend=function() {
							delete PhoneSync_Instance.currentFilePutFile;
							if (PhoneSync_Instance.options.onSave) {
								PhoneSync_Instance.options.onSave(name, obj);
							}
							if (name!=='_files') {
								PhoneSync_Instance.get('_files', function(ret) {
									if (ret===null) {
										ret={
											'key':'_files',
											'files':{'_files':1}
										};
									}
									if (ret.files[name]===undefined) {
										ret.files[name]=1;
										PhoneSync_Instance.save(ret, null, true);
									}
								});
							}
							PhoneSync_Instance.fileLock=false;
							if (PhoneSync_Instance.filePutQueue.length) {
								PhoneSync_Instance.delayFilePutJSON(1);
							}
						};
						writer.write(json);
					},
					function(err) { // failed to create writer
						console.log('ERROR', 'failed to create writer', err);
						PhoneSync_Instance.filePutQueue.unshift(PhoneSync_Instance.currentFilePutFile);
						delete PhoneSync_Instance.currentFilePutFile;
						delete PhoneSync_Instance.fileLock;
						PhoneSync_Instance.delayFilePutJSON();
					}
				);
			},
			function(err) {
				console.error('failed to write file ', name);
				console.error(err);
				PhoneSync_Instance.filePutQueue.unshift(PhoneSync_Instance.currentFilePutFile);
				delete PhoneSync_Instance.currentFilePutFile;
				delete PhoneSync_Instance.fileLock;
				PhoneSync_Instance.delayFilePutJSON();
			}
		);
	}
	else {
		if (PhoneSync_Instance.filePutQueue.length) {
			PhoneSync_Instance.delayFilePutJSON(1);
		}
	}
	// }
};
PhoneSync.prototype.get=function(key, callback, download, failcallback) {
	if (!callback) {
		callback=function(ret) {
			console.log('PhoneSync', ret);
		}
	}
	function doTheGet(rekeys) {
		function delayGet(key, callback, download) {
			return setTimeout(function() {
				PhoneSync_Instance.get(key, callback, download);
			}, 1);
		}
		function fail2() {
			if (download) {
				if (PhoneSync_Instance.inSyncDownloads) {
					PhoneSync_Instance.inSyncDownloads=false;
					PhoneSync_Instance.networkInUse=false;
					PhoneSync_Instance.apiXHR.abort();
				}
				console.log('downloading '+key);
				PhoneSync_Instance.api('syncDownloadOne', {
					'key':key
				}, function(ret) {
					var obj={
						'key':key,
						'obj':ret
					};
					if (PhoneSync_Instance.options.onDownload(key, obj, callback)!==false) {
						PhoneSync_Instance.save(obj, callback, true);
					};
				}, fail, function() {
					console.log('offline - cannot download missing resource: '+key);
				});
			}
			else {
				fail();
			}
		}
		if (!(undefined===rekeys || null === rekeys) && rekeys.changes && rekeys.changes[key]) {
			key=rekeys.changes[key];
		}
		if (PhoneSync_Instance.cache._files) {
			if (PhoneSync_Instance.cache._files.files===undefined) {
				PhoneSync_Instance.cache._files.files={};
			}
			if (PhoneSync_Instance.cache._files.files[key]===undefined && (undefined===download || !download)) {
				if ('_rekeys' === key) {
					rekeys={
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
		for (var i=0;i<PhoneSync_Instance.fileGetQueue.length;++i) {
			if (PhoneSync_Instance.fileGetQueue[i]===key) {
				return delayGet(key, callback, download);
			}
		}
		PhoneSync_Instance.fileGetQueue.push(key);
		if (PhoneSync_Instance.options.dbType=='file') {
			PhoneSync_Instance.fileGetJSON(key,
				function(obj) {
					var arr=[];
					for (var i=0;i<PhoneSync_Instance.fileGetQueue.length;++i) {
						if (PhoneSync_Instance.fileGetQueue[i]!==key) {
							arr.push(PhoneSync_Instance.fileGetQueue[i]);
						}
					}
					PhoneSync_Instance.fileGetQueue=arr;
					PhoneSync_Instance.cache[key]=obj;
					callback($.extend({}, obj));
				},
				function() {
					if (download) {
						if (PhoneSync_Instance.inSyncDownloads) {
							PhoneSync_Instance.inSyncDownloads=false;
							PhoneSync_Instance.networkInUse=false;
							PhoneSync_Instance.apiXHR.abort();
						}
						PhoneSync_Instance.api('syncDownloadOne', {
							'key':key
						}, function(ret) {
							var obj={
								'key':key,
								'obj':ret
							};
							if (PhoneSync_Instance.options.onDownload(key, obj, callback)!==false) {
								PhoneSync_Instance.save(obj, callback, true);
							}
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
		else if (PhoneSync_Instance.options.dbType=='indexeddb') {
			PhoneSync_Instance.idxGetJSON(
				key,
				function(obj) {
					if (obj===undefined) {
						return fail2();
					}
					var arr=[];
					for (var i=0;i<PhoneSync_Instance.fileGetQueue.length;++i) {
						if (PhoneSync_Instance.fileGetQueue[i]!==key) {
							arr.push(PhoneSync_Instance.fileGetQueue[i]);
						}
					}
					PhoneSync_Instance.fileGetQueue=arr;
					PhoneSync_Instance.cache[key]=obj;
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
		for (var i=0;i<PhoneSync_Instance.fileGetQueue.length;++i) {
			if (PhoneSync_Instance.fileGetQueue[i]!==key) {
				arr.push(PhoneSync_Instance.fileGetQueue[i]);
			}
		}
		PhoneSync_Instance.fileGetQueue=arr;
		callback(null);
	}
	
	if (PhoneSync_Instance.disableFS) {
		return;
	}
	if (PhoneSync_Instance.cache[key]) {
		if (!(PhoneSync_Instance.cache[key]===null && download)) {
			return callback($.extend({}, PhoneSync_Instance.cache[key]));
		}
	}
	if ('_rekeys' === key) {
		doTheGet(null);
	}
	else {
		PhoneSync_Instance.get('_rekeys', doTheGet, false, function() {
			obj={
				'key':'_rekeys',
				'changes':{}
			};
			lch.save(obj, false, true);
		});
	}
};
PhoneSync.prototype.getAll=function(key, callback) {
	if (!callback) {
		callback=function(ret) {
			console.log('PhoneSync: '+ret);
		}
	}
	if (PhoneSync_Instance.disableFS) {
		return;
	}
	var keys=[];
	if (PhoneSync_Instance.cache[key]) {
		keys=PhoneSync_Instance.cache[key].obj;
	}
	else {
		PhoneSync_Instance.get(key, function(ret) {
			if (ret===undefined || ret===null) {
				return callback([]);
			}
			PhoneSync_Instance.getAll(key, callback);
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
		PhoneSync_Instance.get(key+'-'+keys[i], getObject);
	}
};
PhoneSync.prototype.getAllById=function(keys, callback) {
	if (!callback) {
		callback=function(ret) {
			console.log('PhoneSync: '+ret);
		}
	}
	function getObject(ret) {
		if (ret!==null) {
			rows.push($.extend({}, ret));
		}
		toGet--;
		if (!toGet) {
			callback(rows);
		}
	}
	if (PhoneSync_Instance.disableFS) {
		return;
	}
	var rows=[], toGet=keys.length, i=0;
	for (;i<keys.length;++i) {
		PhoneSync_Instance.get(keys[i], getObject);
	}
};
PhoneSync.prototype.getSome=function(keys, callback) {
	if (!callback) {
		callback=function(ret) {
			console.log('PhoneSync', ret);
		}
	}
	var toGet=keys.length, vals=[];
	function gather(ret) {
		vals.push(ret);
		toGet--;
		if (!toGet) {
			callback(vals);
		}
	}
	for (var i=0;i<keys.length;++i) {
		lch.get(keys[i], gather);
	}
};
PhoneSync.prototype.idAdd=function(name, id, callback) {
	id=''+id;
	PhoneSync_Instance.get(name, function(ret) {
		if (!ret || !ret.obj) {
			ret={'obj':[]};
		}
		if ($.inArray(id, ret.obj)===-1) {
			ret.obj.push(id);
			PhoneSync_Instance.save({
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
	id=''+id;
	PhoneSync_Instance.get(name, function(ret) {
		ret=ret||{'obj':[]};
		var arr=[];
		if (ret.obj) {
			for (var i=0;i<ret.obj.length;++i) {
				if (id !== ret.obj[i]) {
					arr.push(ret.obj[i]);
				}
			}
		}
		PhoneSync_Instance.save({
			'key':name,
			'obj':arr,
			'id':id // added to let recursive idAdd work
		}, false, true);
	});
};
PhoneSync.prototype.idxPutJSON=function(name, obj) {
	
	if (PhoneSync_Instance.disableFS || 'none'===PhoneSync_Instance.options.dbType) {
		return PhoneSync_Instance.options.onSave?PhoneSync_Instance.options.onSave(name, obj):0;
	}
	// { if a file is submitted, queue it and come back later
	if (name && obj) {
		for (var i=1;i<PhoneSync_Instance.filePutQueue.length;++i) { // if the file is already in the queue, remove the old copy as it is out of date
			var f=PhoneSync_Instance.filePutQueue[i];
			if (f[0]===name) {
				PhoneSync_Instance.filePutQueue.splice(i, 1);
			 break;
			}
		}
		PhoneSync_Instance.filePutQueue.push([name, obj]);
		return PhoneSync_Instance.delayIdxPutJSON(1);
	}
	// }
	// { if a file is currently being written, then come back later
	if (PhoneSync_Instance.idxPutJSONLock) {
		return PhoneSync_Instance.delayIdxPutJSON(1);
	}
	// }
	// { write a file
	PhoneSync_Instance.idxPutJSONLock=true;
	var o=PhoneSync_Instance.filePutQueue.shift();
	if (o) {
		name=o[0];
		obj=o[1];
		var txn=PhoneSync_Instance.fs.transaction([PhoneSync_Instance.options.dbName], 'readwrite');
		var store=txn.objectStore(PhoneSync_Instance.options.dbName);
		txn.onerror=function(e) {
			console.log('ERROR', 'failed to create file', e);
			PhoneSync_Instance.filePutQueue.unshift(o);
			PhoneSync_Instance.delayIdxPutJSON();
		};
		txn.oncomplete=function() {
			if (PhoneSync_Instance.options.onSave) {
				PhoneSync_Instance.options.onSave(name, obj);
			}
			if (name!=='_files') {
				PhoneSync_Instance.get('_files', function(ret) {
					if (ret===null || ret.files===undefined) {
						ret={
							'key':'_files',
							'files':{'_files':1}
						};
					}
					if (ret.files[name]===undefined) {
						ret.files[name]=1;
						setZeroTimeout(function() {
							PhoneSync_Instance.save(ret, null, true);
						});
					}
				});
			}
			PhoneSync_Instance.idxPutJSONLock=false;
			if (PhoneSync_Instance.filePutQueue.length) {
				PhoneSync_Instance.delayIdxPutJSON(1);
			}
		};
		store.put(obj, name);
	}
	else {
		if (PhoneSync_Instance.filePutQueue.length) {
			PhoneSync_Instance.delayIdxPutJSON(1);
		}
	}
	// }
};
PhoneSync.prototype.idxGetJSON=function(name, success, fail) {
	if (PhoneSync_Instance.disableFS) {
		return;
	}
	if (!PhoneSync_Instance.fs) {
		return window.setTimeout(function() {
			PhoneSync_Instance.idxGetJSON(name, success, fail);
		}, PhoneSync_Instance.options.timeout);
	}
	var txn=PhoneSync_Instance.fs.transaction([PhoneSync_Instance.options.dbName]);
	if (txn) {
		var store=txn.objectStore(PhoneSync_Instance.options.dbName);
		var ob=store.get(name);
		ob.onsuccess=function(ev) {
			if (ob.result===undefined) {
				ob.result=null;
			}
			success(ob.result);
		};
		ob.fail=function() {
			fail();
		};
	}
	else {
		console.log('could not open indexeddb transaction');
	}
};
PhoneSync.prototype.nuke=function(callback) {
	if (PhoneSync_Instance.options.dbType=='file') {
		PhoneSync_Instance.disableFS=true;
		try {
			PhoneSync_Instance.fs.removeRecursively(function() {
				console.log('successfully nuked. rebuilding now.');
				window.requestFileSystem(
					LocalFileSystem.PERSISTENT, 0,
					function(filesystem) {
						var entry=filesystem.root;
						function createRoot() {
							entry.getDirectory(
								PhoneSync_Instance.options.dbName,
								{'create':true, 'exclusive':false},
								function(root) {
									PhoneSync_Instance.fs=root;
									PhoneSync_Instance.disableFS=false;
									PhoneSync_Instance.delaySyncDownloads();
									PhoneSync_Instance.delaySyncUploads();
									PhoneSync_Instance.options.ready(PhoneSync_Instance);
									for (var i in PhoneSync_Instance.tables) {
										PhoneSync_Instance.tables[i].lastUpdate='0000-00-00 00:00:00';
									}
									PhoneSync_Instance.save( { 'key':'_tables', 'obj':PhoneSync_Instance.tables }, false, true);
									callback();
								},
								function(e) {
									console.log(e);
									setTimeout(createRoot, PhoneSync_Instance.options.timeout);
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
	else if (PhoneSync_Instance.options.dbType=='indexeddb') {
		PhoneSync_Instance.disableFS=true;
		console.log('okay - about to request the deletion');
		var req=indexedDB.deleteDatabase(PhoneSync_Instance.options.dbName);
		req.onerror=function() {
			console.log('failed to nuke');
		};
		if (callback) {
			callback();
		}
	}
	else {
		if (callback) {
			callback();
		}
	}
	PhoneSync_Instance.tablesLastUpdateClear();
	PhoneSync_Instance.alreadyDoingSyncUpload=0;
	PhoneSync_Instance.cache={};
};
PhoneSync.prototype.rekey=function(table, oldId, newId, callback) {
	if (oldId==newId) {
		return;
	}
	PhoneSync_Instance.get('_rekeys', function(obj) {
		if (null === obj) {
			obj={
				'key':'_rekeys',
				'changes':{}
			};
		}
		obj.changes[table+'-'+oldId]=table+'-'+newId;
		lch.save(obj, null, true);
	});
	PhoneSync_Instance.get(table+'-'+oldId, function(obj) {
 		if (obj===null) { // temporary failure?
 			console.warn('re-attempting to rekey '+table+'-'+oldId+' to '+newId);
 			setTimeout(function() {
 				PhoneSync_Instance.rekey(table, oldId, newId, callback);
 			}, 1000);
 		}
 		else {
 			obj.key=table+'-'+newId;
 			obj.obj.id=newId;
 			PhoneSync_Instance.save(obj, callback, true);
 			PhoneSync_Instance.delete(table+'-'+oldId);
 		}
	});
};
PhoneSync.prototype.sanitise=function(name) {
	return name.replace(/[^a-zA-Z0-9\-]/g, '');
};
PhoneSync.prototype.save=function(obj, callback, nosync) {
	PhoneSync_Instance.options.onBeforeSave(obj.key, obj);
	if (PhoneSync_Instance.disableFS) {
		return;
	}
	PhoneSync_Instance.cache[obj.key]=obj;
	var id=obj.obj && obj.obj.id ? obj.obj.id : obj.id;
	if (/-/.test(obj.key) && id) {
		PhoneSync_Instance.idAdd(obj.key.replace(/-[^-]*$/, ''), id, function() {
			if (callback) {
				setZeroTimeout(callback);
			}
			if (!(nosync || /^_/.test(obj.key))) {
				PhoneSync_Instance.addToSyncUploads(obj.key);
			}
			if (PhoneSync_Instance.options.dbType=='file') {
				PhoneSync_Instance.filePutJSON(obj.key, obj);
			}
			else if (PhoneSync_Instance.options.dbType=='indexeddb') {
				PhoneSync_Instance.idxPutJSON(obj.key, obj);
			}
		});
	}
	else {
		if (callback) {
			setZeroTimeout(callback);
		}
		if (!nosync) {
			PhoneSync_Instance.addToSyncUploads(obj.key);
		}
		if (PhoneSync_Instance.options.dbType=='file') {
			PhoneSync_Instance.filePutJSON(obj.key, obj);
		}
		else if (PhoneSync_Instance.options.dbType=='indexeddb') {
			PhoneSync_Instance.idxPutJSON(obj.key, obj);
		}
	}
};
PhoneSync.prototype.syncDownloads=function() {
	if (!PhoneSync_Instance.allowDownloads || !window.credentials || PhoneSync_Instance.inSyncDownloads) {
		return PhoneSync_Instance.delaySyncDownloads(PhoneSync_Instance.options.syncDownloadsTimeout);
	}
	if (PhoneSync_Instance.apiAlreadyInQueue('syncDownloads')) {
		return;
	}
	if (PhoneSync_Instance.disableFS) {
		console.log('fs disabled');
		return;
	}
	if (!PhoneSync_Instance.loggedIn) {
		return PhoneSync_Instance.delaySyncDownloads(15000);
	}
	PhoneSync_Instance.inSyncDownloads=true;
	clearTimeout(window.PhoneSync_timerSyncDownloads);
	PhoneSync_Instance.api(
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
				var deletes=v, tableUpdatesChanged=false, i=0;
				for (;i<v.length;++i) {
					var obj=v[i];
					if (!PhoneSync_Instance.tables[k].lastUpdate || obj.last_edited>PhoneSync_Instance.tables[k].lastUpdate) {
						PhoneSync_Instance.tables[k].lastUpdate=obj.last_edited;
						tableUpdatesChanged=true;
						changes++;
					}
				}
				if (tableUpdatesChanged) {
					PhoneSync_Instance.save( { 'key':'_tables', 'obj':PhoneSync_Instance.tables }, false, true);
				}
				for (i=0;i<deletes.length;++i) {
					if (deletes[i].key===undefined) {
						deletes[i].key=deletes[i].table_name+'-'+deletes[i].item_id;
					}
					PhoneSync_Instance.delete(deletes[i].key);
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
							PhoneSync_Instance.save( { 'key':'_tables', 'obj':PhoneSync_Instance.tables }, false, true);
						}
						tablesToDo--;
						if (!tablesToDo) {
							PhoneSync_Instance.inSyncDownloads=false;
							PhoneSync_Instance.delaySyncDownloads(changes?100:PhoneSync_Instance.options.syncDownloadsTimeout);
						}
						return;
					}
					var obj=v[i];
					i++;
					if (obj===null) {
						return setZeroTimeout(next);
					}
					if (!PhoneSync_Instance.tables[k].lastUpdate || (''+obj.last_edited)>PhoneSync_Instance.tables[k].lastUpdate) {
						PhoneSync_Instance.tables[k].lastUpdate=obj.last_edited;
						tableUpdatesChanged=true;
						changes++;
					}
					(function(k, obj) {
						PhoneSync_Instance.get(k+'-'+obj.id, function(ret) {
							if (ret===null) {
								PhoneSync_Instance.options.onDownload(k+'-'+obj.id, obj);
							}
							if (PhoneSync_Instance.uuid==obj.uuid) { // originally came from device
								if (ret===null) {
									PhoneSync_Instance.save({
										'key':k+'-'+obj.id,
										'obj':obj
									}, next, true);
									PhoneSync_Instance.options.onUpdate(k+'-'+obj.id, obj);
								}
								else setZeroTimeout(next);
							}
							else { // created somewhere else
								PhoneSync_Instance.save({
									'key':k+'-'+obj.id,
									'obj':obj
								}, next, true);
								PhoneSync_Instance.options.onUpdate(k+'-'+obj.id, obj);
							}
						});
					})(k, obj);
				}
				next();
			});
			if (!tablesToDo) {
				PhoneSync_Instance.inSyncDownloads=false;
				PhoneSync_Instance.delaySyncDownloads(changes?100:PhoneSync_Instance.options.syncDownloadsTimeout);
			}
		},
		function(err) {
			PhoneSync_Instance.inSyncDownloads=false;
			PhoneSync_Instance.delaySyncDownloads(PhoneSync_Instance.options.syncDownloadsTimeout);
		}
	);
};
PhoneSync.prototype.syncUploads=function() {
	if (!PhoneSync_Instance.loggedIn || !window.credentials) {
		return PhoneSync_Instance.delaySyncUploads(5000);
	}
	if (PhoneSync_Instance.apiAlreadyInQueue('syncUploads')) {
		return;
	}
	if (PhoneSync_Instance.alreadyDoingSyncUpload) {
		return PhoneSync_Instance.delaySyncUploads(1);
	}
	if (PhoneSync_Instance.inSyncDownloads) {
		PhoneSync_Instance.apiQueueClear('syncDownloads');
	}
	var numberOfUploads=++PhoneSync_Instance.numberOfUploads;
	if (PhoneSync_Instance.disableFS) {
		return;
	}
	PhoneSync_Instance.get('_syncUploads', function(obj) {
		if (!obj || obj===undefined || obj.keys===undefined || obj.keys.length===0) { // nothing to upload
			PhoneSync_Instance.delaySyncDownloads();
			return;
		}
		var key=obj.keys[0];
		PhoneSync_Instance.delayAllowDownloads();
		if (/^_/.test(key)) { // items beginning with _ should not be uploaded
			obj.keys.shift();
			return PhoneSync_Instance.save(obj, function() {
				console.log('syncUploads contained an invalid key, '+key+'. removed.');
				PhoneSync_Instance.delaySyncUploads(1);
			}, true);
		}
		if (PhoneSync_Instance.alreadyDoingSyncUpload) {
			console.log('already uploading.');
			return PhoneSync_Instance.delaySyncUploads(1);
		}
		PhoneSync_Instance.alreadyDoingSyncUpload=1;
		PhoneSync_Instance.get(key, function(ret) {
			if (ret===null) { // item does not appear to exist?
				console.warn('object with key '+key+' does not appear to exist. pushing to end of upload queue');
				obj.keys.shift();
				obj.keys.push(key);
				return PhoneSync_Instance.save(obj, function() {
					PhoneSync_Instance.alreadyDoingSyncUpload=0;
					PhoneSync_Instance.delaySyncUploads(1);
				}, true);
			}
			if (PhoneSync_Instance.inSyncDownloads) {
				PhoneSync_Instance.inSyncDownloads=false;
				PhoneSync_Instance.networkInUse=false;
				PhoneSync_Instance.apiXHR.abort();
			}
			window.syncUploadsClearTimeout=setTimeout(function() {
				PhoneSync_Instance.alreadyDoingSyncUpload=0;
			}, 60000);
			PhoneSync_Instance.api(
				'syncUploads', {
					'key':ret.key,
					'obj':JSON.stringify(ret.obj)
				},
				function(ret) { //  success
					clearTimeout(window.syncUploadsClearTimeout);
					if (obj.keys[0]!==key) {
						console.warn('DUPLICATE UPLOADED?? '+key);
						PhoneSync_Instance.delaySyncUploads(1);
						PhoneSync_Instance.alreadyDoingSyncUpload=0;
						return;
					}
					obj.keys.shift();
					PhoneSync_Instance.save(obj, function() { // remove PhoneSync_Instance item from the queue
						PhoneSync_Instance.alreadyDoingSyncUpload=0;
						PhoneSync_Instance.delaySyncUploads(1);
						PhoneSync_Instance.delaySyncDownloads();
						if (ret) {
							PhoneSync_Instance.options.onUpload(key, ret);
						}
					}, true);
				},
				function(err) { // fail
					clearTimeout(window.syncUploadsClearTimeout);
					console.log('upload failed');
					PhoneSync_Instance.alreadyDoingSyncUpload=0;
					PhoneSync_Instance.delaySyncUploads();
					PhoneSync_Instance.delaySyncDownloads();
				}
			);
		});
	});
};
PhoneSync.prototype.tablesLastUpdateClear=function() {
	for (var i=0;i<PhoneSync_Instance.options.tables.length;++i) {
		PhoneSync_Instance.tables[PhoneSync_Instance.options.tables[i]]={
			'lastUpdate':'0000-00-00 00:00:00'
		};
	}
};
