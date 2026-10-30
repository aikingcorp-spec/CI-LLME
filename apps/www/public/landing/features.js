// Single source of truth for what is live. Flip a flag and the page updates; no redesign.
// available:false => a "Sắp có" label/state is rendered where the item appears.
window.VNBOT_FEATURES={
  WEB_APP_URL:'https://app.vnbot.run',
  webAppLive:false,            // public WEB_APP_URL reachable? (app.vnbot.run has no DNS yet) false => contact is primary, web button inert
  showFree:true,               // hero "Miễn phí" wording + 0đ section + free nav/FAQ
  CONTACT_URL:'https://aikingx.com',
  downloads:{                  // the ONLY platforms shown in the download grid; enabled:false => "Sắp có", true => real download button
    windows:{enabled:false,url:'https://vnbot.run/download/VNBot-Setup.exe',label:'Windows',msi:{url:'/download/VNBot-Setup.msi',label:'MSI (doanh nghiệp)'}},
    linux:{enabled:false,url:'https://vnbot.run/download/VNBot.AppImage',label:'Linux'}
  },
  pausedPlatforms:[            // paused, not dropped: listed as "Sắp có" in platform lines only, never in the download grid
    {id:'mac',name:'macOS'},
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
