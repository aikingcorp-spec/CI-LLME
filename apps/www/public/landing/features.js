// Single source of truth for what is live. Flip a flag and the page updates; no redesign.
// available:false => a "Sắp có" label/state is rendered where the item appears.
window.VNBOT_FEATURES={
  WEB_APP_URL:'https://app.vnbot.run',
  webAppLive:false,            // public WEB_APP_URL reachable? (app.vnbot.run has no DNS yet) false => contact is primary, web button inert
  showFree:true,               // hero "Miễn phí" wording + 0đ section + free nav/FAQ
  CONTACT_URL:'https://aikingx.com',
  // sizeMB = Math.round(bytes / 1_048_576), labelled MB as Windows displays it; null when no file is published.
  downloads:{                  // the ONLY platforms shown in the download grid; enabled:false => "Sắp có", true => real download button
    windows:{enabled:true,version:'0.3.6',file:'VNBot-Setup-0.3.6-x64.exe',url:'https://dl.vnbot.run/desktop/VNBot-Setup-0.3.6-x64.exe',sizeMB:170,sha256:'8682aa010f9280cb21c88473022073b61e00694da365b4766309c7e093c9dde3',notesUrl:null,req:'Windows 10/11 64-bit',label:'Windows',note:{vi:'Bản thử chưa ký số: Windows có thể hiện cảnh báo SmartScreen. Bấm “Thông tin thêm” rồi “Vẫn chạy”.',en:'This preview build isn\'t signed yet, so Windows SmartScreen may show a warning. Click “More info”, then “Run anyway”.'},msi:{file:'VNBot-0.3.6-win-x64.msi',url:'https://dl.vnbot.run/desktop/VNBot-0.3.6-win-x64.msi',sizeMB:185,sha256:'eb640894a4af3805d019a860d210a23f31bdb3597d92f7cfda54def585e44801',notesUrl:null,req:'Windows 10/11 64-bit'}},
    linux:{enabled:false,version:'0.3.6',file:'VNBot-0.3.6-linux-x86_64.AppImage',url:'https://dl.vnbot.run/desktop/VNBot-0.3.6-linux-x86_64.AppImage',sizeMB:null,sha256:null,notesUrl:null,req:'Linux x86_64',label:'Linux'}
  },
  sumsUrl:'https://dl.vnbot.run/desktop/SHA256SUMS.txt',
  pausedPlatforms:[            // paused, not dropped: listed as "Sắp có" in platform lines only, never in the download grid
    {id:'mac',name:'Mac'},
    {id:'android',name:'Android'},
    {id:'ios',name:'iOS'}
  ],
  platforms:{
    web:{name:'Web'}                     // availability derives from webAppLive (web client app.vnbot.run -> your node)
  },
  features:{
    bots:{available:true},          // one job per bot, memory
    computer:{available:true},      // own browser/terminal/files
    schedule:{available:true},
    connectors:{available:true},    // apps, MCP, API
    voice:{available:true},
    groupChat:{available:true},
    ownNode:{available:true},       // runs on your machine
    remoteAccess:{available:false} // web/phone from anywhere via vnbot.run gateway (P2P, ADR 0001: Proposed, not built)
  }
};
window.VNBOT_FEATURES.platforms.web.available=window.VNBOT_FEATURES.webAppLive;

// All landing size labels use the shared download metadata.
window.VNBOT_FEATURES.sizeMB = function (download) { return download.sizeMB === null ? "" : download.sizeMB + " MB"; };
