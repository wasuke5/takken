/* ============================================================
   学習データのバックアップ／復元（全ページ共通）
   ------------------------------------------------------------
   この端末に保存された記録（間違えた問題・あとで解く・進み具合・
   過去問の解答）を 1 本の文字列にまとめてコピーし、貼り付けで戻す。
   ・問題文（label / kind）は各ページの元データから組み立て直せるので入れない
   ・「area:3」のような問題番号の並びは詰めて書き、gzip で縮めて短くする
   ============================================================ */
(function(){
  'use strict';

  var PREFIXES   = ['takken_', 'gyouhou_', 'shakuchi_shakuya_'];
  var HEAD_GZ    = 'TKB1.';   // gzip ＋ base64url
  var HEAD_RAW   = 'TKB0.';   // 圧縮できないブラウザ用（JSON そのまま）
  var LINE_LIMIT = 9000;      // これを超えたら LINE では切れるおそれがあると案内する

  function ours(key){
    for(var i = 0; i < PREFIXES.length; i++){
      if(key.indexOf(PREFIXES[i]) === 0) return true;
    }
    return false;
  }
  function isLabelStore(key){ return /_(wrong|marked)_v\d+$/.test(key); }

  function listKeys(){
    var out = [];
    try{
      for(var i = 0; i < localStorage.length; i++){
        var k = localStorage.key(i);
        if(k && ours(k)) out.push(k);
      }
    }catch(e){}
    return out;
  }

  /* ---- 問題番号の並び（出題順）を詰めて書く ---- */
  var QID = /^([A-Za-z0-9_]+):(\d+)$/;

  function packQids(arr){
    if(arr.length < 4) return null;
    var parts = [], cur = null, nums = [];
    for(var i = 0; i < arr.length; i++){
      var m = (typeof arr[i] === 'string') && QID.exec(arr[i]);
      if(!m) return null;
      if(m[1] !== cur){
        if(cur !== null) parts.push(cur + ':' + nums.join(','));
        cur = m[1];
        nums = [];
      }
      nums.push(m[2]);
    }
    parts.push(cur + ':' + nums.join(','));
    return {$q: parts.join(';')};
  }
  function unpackQids(s){
    var out = [];
    s.split(';').forEach(function(p){
      var c = p.indexOf(':');
      var pre = p.slice(0, c);
      p.slice(c + 1).split(',').forEach(function(n){ out.push(pre + ':' + n); });
    });
    return out;
  }
  function pack(v){
    if(Array.isArray(v)) return packQids(v) || v.map(pack);
    if(v && typeof v === 'object'){
      var o = {};
      Object.keys(v).forEach(function(k){ o[k] = pack(v[k]); });
      return o;
    }
    return v;
  }
  function unpack(v){
    if(Array.isArray(v)) return v.map(unpack);
    if(v && typeof v === 'object'){
      var ks = Object.keys(v);
      if(ks.length === 1 && ks[0] === '$q' && typeof v.$q === 'string') return unpackQids(v.$q);
      var o = {};
      ks.forEach(function(k){ o[k] = unpack(v[k]); });
      return o;
    }
    return v;
  }

  /* ---- 端末の記録を集める ---- */
  function collect(){
    var d = {}, r = {};
    listKeys().forEach(function(k){
      var raw;
      try{ raw = localStorage.getItem(k); }catch(e){ return; }
      if(raw === null || raw === '') return;
      var val;
      try{ val = JSON.parse(raw); }catch(e){ val = undefined; }
      if(val && typeof val === 'object'){
        if(isLabelStore(k) && !Array.isArray(val)){
          var slim = {};
          Object.keys(val).forEach(function(qid){
            var e = val[qid] || {}, c = {};
            Object.keys(e).forEach(function(f){
              if(f !== 'label' && f !== 'kind') c[f] = e[f];
            });
            slim[qid] = c;
          });
          val = slim;
        }
        d[k] = pack(val);
      }else{
        r[k] = raw;
      }
    });
    return {v:1, at:Date.now(), d:d, r:r};
  }

  function summarize(d){
    var w = 0, m = 0, ex = 0;
    Object.keys(d || {}).forEach(function(k){
      var v = d[k];
      if(!v || typeof v !== 'object') return;
      if(/_wrong_v\d+$/.test(k))       w += Object.keys(v).length;
      else if(/_marked_v\d+$/.test(k)) m += Object.keys(v).length;
      else if(/^takken_kakomon_v\d+$/.test(k)){
        Object.keys(v).forEach(function(id){
          var s = v[id];
          if(s && s.ans && Object.keys(s.ans).length) ex++;
        });
      }
    });
    return '間違えた問題 ' + w + '問／あとで解く ' + m + '問／過去問 ' + ex + '回分';
  }

  /* ---- 文字列にする／文字列から戻す ---- */
  function toB64url(bytes){
    var s = '';
    for(var i = 0; i < bytes.length; i += 0x8000){
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(s){
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while(s.length % 4) s += '=';
    var bin = atob(s), a = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function streamBytes(bytes, stream){
    return new Response(new Blob([bytes]).stream().pipeThrough(stream))
      .arrayBuffer()
      .then(function(b){ return new Uint8Array(b); });
  }

  function encode(obj){
    var json = JSON.stringify(obj);
    if(typeof CompressionStream === 'undefined') return Promise.resolve(HEAD_RAW + json);
    return streamBytes(new TextEncoder().encode(json), new CompressionStream('gzip'))
      .then(function(b){ return HEAD_GZ + toB64url(b); })
      .catch(function(){ return HEAD_RAW + json; });
  }

  function fail(code){ var e = new Error(code); e.code = code; return e; }

  function decode(text){
    var t = String(text || '').trim();
    var at = t.indexOf('TKB');
    if(at < 0) return Promise.reject(fail('notbackup'));
    t = t.slice(at);   // 前に余計な文字が付いていても拾う

    if(t.indexOf(HEAD_GZ) === 0){
      if(typeof DecompressionStream === 'undefined') return Promise.reject(fail('old'));
      var body = t.slice(HEAD_GZ.length).replace(/[^A-Za-z0-9\-_]/g, '');
      var bytes;
      try{ bytes = fromB64url(body); }catch(e){ return Promise.reject(fail('broken')); }
      return streamBytes(bytes, new DecompressionStream('gzip'))
        .then(function(b){ return JSON.parse(new TextDecoder().decode(b)); })
        .catch(function(){ throw fail('broken'); });
    }
    if(t.indexOf(HEAD_RAW) === 0){
      try{ return Promise.resolve(JSON.parse(t.slice(HEAD_RAW.length))); }
      catch(e){ return Promise.reject(fail('broken')); }
    }
    return Promise.reject(fail('notbackup'));
  }

  /* ---- 端末の記録をバックアップの内容で置き換える ---- */
  function apply(obj){
    var before = {};
    listKeys().forEach(function(k){
      try{ before[k] = localStorage.getItem(k); }catch(e){}
    });

    var writes = {};
    Object.keys(obj.d || {}).forEach(function(k){
      if(!ours(k)) return;
      var val = unpack(obj.d[k]);
      /* 同じ問題の記録がこの端末にあれば、その問題文をそのまま引き継ぐ */
      if(isLabelStore(k) && val && typeof val === 'object' && !Array.isArray(val)){
        var prev = {};
        try{ prev = JSON.parse(before[k]) || {}; }catch(e){}
        Object.keys(val).forEach(function(qid){
          var p = prev[qid], e = val[qid];
          if(p && e && typeof e === 'object'){
            if(p.label && !e.label) e.label = p.label;
            if(p.kind  && !e.kind)  e.kind  = p.kind;
          }
        });
      }
      writes[k] = JSON.stringify(val);
    });
    Object.keys(obj.r || {}).forEach(function(k){
      if(ours(k) && typeof obj.r[k] === 'string') writes[k] = obj.r[k];
    });

    try{
      Object.keys(before).forEach(function(k){ localStorage.removeItem(k); });
      Object.keys(writes).forEach(function(k){ localStorage.setItem(k, writes[k]); });
    }catch(e){
      /* 途中で失敗したら元の記録に戻す */
      try{
        listKeys().forEach(function(k){ localStorage.removeItem(k); });
        Object.keys(before).forEach(function(k){ localStorage.setItem(k, before[k]); });
      }catch(e2){}
      throw fail('save');
    }
  }

  /* ---- 画面 ---- */
  var CSS = ''
    + '.tkb-scrim{position:fixed;inset:0;background:rgba(20,18,14,.5);z-index:10000;}'
    + '.tkb-box{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10001;'
    +   'width:calc(100% - 32px);max-width:480px;max-height:calc(100% - 32px);overflow-y:auto;'
    +   '-webkit-overflow-scrolling:touch;background:#fff;color:#26251f;border-radius:14px;'
    +   'box-shadow:0 10px 40px rgba(0,0,0,.25);padding:16px 18px 18px;text-align:left;'
    +   'font-family:"Hiragino Sans","Yu Gothic",-apple-system,"Segoe UI",Meiryo,sans-serif;line-height:1.6;}'
    + '.tkb-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;}'
    + '.tkb-head b{flex:1 1 auto;font-size:1.02rem;}'
    + '.tkb-x{border:none;background:transparent;color:#77726a;font-size:1.5rem;line-height:1;cursor:pointer;padding:4px 6px;}'
    + '.tkb-lead{margin:0 0 12px;font-size:.78rem;color:#77726a;}'
    + '.tkb-sec{border-top:1px solid #e3e0d7;padding-top:12px;margin-top:12px;}'
    + '.tkb-sec h3{margin:0 0 6px;font-size:.9rem;}'
    + '.tkb-now,.tkb-hint{margin:0 0 8px;font-size:.75rem;color:#77726a;}'
    + '.tkb-hint b{color:#26251f;}'
    + '.tkb-btn{display:block;width:100%;padding:12px;border:none;border-radius:10px;cursor:pointer;'
    +   'background:#b5561f;color:#fff;font:inherit;font-size:.92rem;font-weight:700;}'
    + '.tkb-btn:disabled{opacity:.55;cursor:default;}'
    + '.tkb-btn.tkb-sub{background:#3c4a36;}'
    + '.tkb-box textarea{display:block;width:100%;box-sizing:border-box;margin:8px 0;padding:8px 10px;'
    +   'border:1px solid #e3e0d7;border-radius:8px;background:#fbfaf6;color:#26251f;'
    +   'font-size:16px;line-height:1.4;font-family:ui-monospace,Menlo,Consolas,monospace;resize:vertical;word-break:break-all;}'
    + '.tkb-msg{margin:6px 0 0;font-size:.8rem;min-height:0;}'
    + '.tkb-msg:empty{display:none;}'
    + '.tkb-msg.ok{color:#2f7a45;}'
    + '.tkb-msg.ng{color:#c73e3e;}'
    + '.tkb-msg.warn{color:#9a6a12;}';

  var ui = null;
  var lastFocus = null;

  function build(){
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var scrim = document.createElement('div');
    scrim.className = 'tkb-scrim';
    scrim.hidden = true;

    var box = document.createElement('div');
    box.className = 'tkb-box';
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'tkb-ttl');
    box.innerHTML = ''
      + '<div class="tkb-head"><b id="tkb-ttl">💾 データのバックアップ</b>'
      +   '<button type="button" class="tkb-x" aria-label="閉じる">×</button></div>'
      + '<p class="tkb-lead">間違えた問題・あとで解く・解いた進み具合・過去問の解答を、全ページ分まとめて1本の文字列にします。</p>'
      + '<div class="tkb-sec">'
      +   '<h3>① バックアップする</h3>'
      +   '<p class="tkb-now" id="tkb-now"></p>'
      +   '<button type="button" class="tkb-btn" id="tkb-copy" disabled>準備中…</button>'
      +   '<p class="tkb-msg" id="tkb-copymsg"></p>'
      +   '<textarea id="tkb-out" rows="3" readonly aria-label="バックアップの文字列"></textarea>'
      +   '<p class="tkb-hint">保管先は <b>iPhoneの「メモ」</b> や <b>Google Keep</b> などのメモアプリがおすすめです。</p>'
      + '</div>'
      + '<div class="tkb-sec">'
      +   '<h3>② 復元する</h3>'
      +   '<p class="tkb-hint">保管した文字列をコピーして、下の欄を長押し →「ペースト」。今のデータは上書きされます。</p>'
      +   '<textarea id="tkb-in" rows="3" placeholder="ここに貼り付け" aria-label="復元する文字列"></textarea>'
      +   '<button type="button" class="tkb-btn tkb-sub" id="tkb-load">読み込む</button>'
      +   '<p class="tkb-msg" id="tkb-loadmsg"></p>'
      + '</div>';

    document.body.appendChild(scrim);
    document.body.appendChild(box);

    ui = {
      scrim: scrim, box: box,
      now:     box.querySelector('#tkb-now'),
      copy:    box.querySelector('#tkb-copy'),
      copyMsg: box.querySelector('#tkb-copymsg'),
      out:     box.querySelector('#tkb-out'),
      inp:     box.querySelector('#tkb-in'),
      load:    box.querySelector('#tkb-load'),
      loadMsg: box.querySelector('#tkb-loadmsg'),
    };

    scrim.onclick = close;
    box.querySelector('.tkb-x').onclick = close;
    ui.copy.onclick = onCopy;
    ui.load.onclick = onLoad;
    document.addEventListener('keydown', function(ev){
      if(ev.key === 'Escape' && !ui.box.hidden) close();
    });
  }

  function msg(el, text, kind){
    el.textContent = text || '';
    el.className = 'tkb-msg' + (kind ? ' ' + kind : '');
  }

  function open(){
    if(!ui) build();
    lastFocus = document.activeElement;
    ui.scrim.hidden = false;
    ui.box.hidden = false;
    ui.box.scrollTop = 0;
    document.documentElement.style.overflow = 'hidden';
    msg(ui.copyMsg, '');
    msg(ui.loadMsg, '');
    ui.inp.value = '';
    ui.out.value = '';
    ui.load.disabled = false;
    ui.copy.disabled = true;
    ui.copy.textContent = '準備中…';

    var data = collect();
    ui.now.textContent = '今のデータ：' + summarize(data.d);
    encode(data).then(function(code){
      ui.out.value = code;
      ui.copy.disabled = false;
      ui.copy.textContent = 'バックアップをコピー（' + code.length.toLocaleString() + '文字）';
    }).catch(function(){
      ui.copy.textContent = '作成できませんでした';
    });
    ui.box.querySelector('.tkb-x').focus();
  }

  function close(){
    if(!ui) return;
    ui.scrim.hidden = true;
    ui.box.hidden = true;
    document.documentElement.style.overflow = '';
    if(lastFocus && lastFocus.focus){ try{ lastFocus.focus(); }catch(e){} }
  }

  function legacyCopy(ta){
    try{
      ta.removeAttribute('readonly');
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      ta.setAttribute('readonly', '');
      ta.blur();
      return ok;
    }catch(e){
      ta.setAttribute('readonly', '');
      return false;
    }
  }

  function onCopy(){
    var code = ui.out.value;
    if(!code) return;
    var p = (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext)
      ? navigator.clipboard.writeText(code).then(function(){ return true; }, function(){ return legacyCopy(ui.out); })
      : Promise.resolve(legacyCopy(ui.out));
    p.then(function(ok){
      if(ok){
        var text = 'コピーしました。メモアプリに貼り付けて保管してください。';
        if(code.length > LINE_LIMIT) text += '（文字数が多いので、LINEだと途中で切れることがあります）';
        msg(ui.copyMsg, text, code.length > LINE_LIMIT ? 'warn' : 'ok');
      }else{
        ui.out.focus();
        ui.out.select();
        msg(ui.copyMsg, '自動でコピーできませんでした。下の欄を長押しして「すべてを選択」→「コピー」してください。', 'ng');
      }
    });
  }

  function fmtDate(ms){
    var d = new Date(ms);
    if(isNaN(d.getTime())) return '不明';
    function z(n){ return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + z(d.getMonth() + 1) + '/' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
  }

  var ERRORS = {
    notbackup: 'バックアップの文字列ではないようです。コピーし直して貼り付けてください。',
    broken:    '文字列が途中で切れているか、壊れています。最後までコピーできているか確認してください。',
    old:       'このブラウザでは読み込めません。iOS・Android・ブラウザを新しくしてからお試しください。',
    save:      '保存に失敗しました。今のデータはそのまま残っています。',
  };

  function onLoad(){
    var text = ui.inp.value;
    if(!text.trim()){
      msg(ui.loadMsg, '文字列を貼り付けてから押してください。', 'ng');
      return;
    }
    ui.load.disabled = true;
    msg(ui.loadMsg, '');
    decode(text).then(function(obj){
      if(!obj || obj.v !== 1 || !obj.d || typeof obj.d !== 'object') throw fail('notbackup');
      var ok = confirm('このバックアップで今のデータを上書きします。\n\n'
        + '作成日時：' + fmtDate(obj.at) + '\n'
        + summarize(obj.d) + '\n\nよろしいですか？');
      if(!ok){ ui.load.disabled = false; return; }
      apply(obj);
      alert('復元しました。ページを読み込み直します。');
      location.reload();
    }).catch(function(err){
      msg(ui.loadMsg, ERRORS[err && err.code] || ERRORS.broken, 'ng');
      ui.load.disabled = false;
    });
  }

  /* ---- 入口：[data-backup-open] を押すと開く。ページ上部のナビにも自動で置く ---- */
  document.addEventListener('click', function(ev){
    var t = ev.target && ev.target.closest && ev.target.closest('[data-backup-open]');
    if(!t) return;
    ev.preventDefault();
    open();
  });

  var nav = document.querySelector('nav.sitenav');
  if(nav && !nav.querySelector('[data-backup-open]')){
    var a = document.createElement('a');
    a.href = '#';
    a.setAttribute('data-backup-open', '');
    a.textContent = '💾 バックアップ';
    nav.appendChild(a);
  }

  /* 動作確認用 */
  window.TakkenBackup = {collect:collect, encode:encode, decode:decode, apply:apply, open:open};
})();
