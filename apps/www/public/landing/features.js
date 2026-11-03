// Single source of truth for what is live. Flip a flag and the page updates; no redesign.
// available:false => a "Sắp có" label/state is rendered where the item appears.
window.VNBOT_FEATURES={
  WEB_APP_URL:'https://app.vnbot.run',
  webAppLive:false,            // public WEB_APP_URL reachable? (app.vnbot.run has no DNS yet) false => contact is primary, web button inert
  showFree:true,               // hero "Miễn phí" wording + 0đ section + free nav/FAQ
  CONTACT_URL:'https://aikingx.com',
  // sizeMB = Math.round(bytes / 1_048_576), labelled MB as Windows displays it; null when no file is published.
  downloads:{                  // the ONLY platforms shown in the download grid; enabled:false => "Sắp có", true => real download button
    windows:{enabled:true,version:'0.3.8',file:'VNBot-Setup-0.3.8-x64.exe',url:'https://dl.vnbot.run/desktop/VNBot-Setup-0.3.8-x64.exe',sizeMB:168,sha256:'b9723a43511f61f1b210fc50ac7da3078dac2f8b1f723dc935d8be66f89fe8a9',notesUrl:null,req:'Windows 10/11 64-bit',label:'Windows',note:{vi:'Bản thử chưa ký số: Windows có thể hiện cảnh báo SmartScreen. Bấm “Thông tin thêm” rồi “Vẫn chạy”.',en:'This preview build isn\'t signed yet, so Windows SmartScreen may show a warning. Click “More info”, then “Run anyway”.'},msi:{file:'VNBot-0.3.8-win-x64.msi',url:'https://dl.vnbot.run/desktop/VNBot-0.3.8-win-x64.msi',sizeMB:183,sha256:'323122c50b18e79a878b6c99e6469ae71073e1436f0778c34c797f2d45fff393',notesUrl:null,req:'Windows 10/11 64-bit'}},
    linux:{enabled:true,version:'0.3.8',file:'VNBot-0.3.8-linux-x86_64.AppImage',url:'https://dl.vnbot.run/desktop/VNBot-0.3.8-linux-x86_64.AppImage',sizeMB:191,sha256:'65d3461b0622453c628fdee23ce251a03ea0834428c028d091d3f9419ab53266',notesUrl:null,req:'Linux x86_64',label:'Linux',deb:{file:'VNBot-0.3.8-linux-amd64.deb',url:'https://dl.vnbot.run/desktop/VNBot-0.3.8-linux-amd64.deb',sizeMB:167,sha256:'5cb930f288c692a5a52ce7d1e233e4de9721c5ba2cf199d8a4c2fa4673433039'}}
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
