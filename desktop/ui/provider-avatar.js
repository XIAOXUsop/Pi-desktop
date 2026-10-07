const brands={deepseek:['deepseek',40],zhipu:['zhipuai',40],moonshot:['moonshotai-cn',40],dashscope:['alibaba',40],minimax:['minimax',40],openai:['openai',40],anthropic:['anthropic',40],siliconflow:['siliconflow-cn',40],openrouter:['openrouter',24],'opencode-go':['opencode-go',24],'command-code-goat':['command-code-goat',700]};
const aliases={'zhipuai':'zhipu','zai':'zhipu','moonshotai':'moonshot','moonshotai-cn':'moonshot','alibaba':'dashscope','alibaba-cn':'dashscope','siliconflow-cn':'siliconflow'};

// Use the service identity, never a model name: e.g. DeepSeek via OpenRouter
// must retain the OpenRouter avatar. No URLs or HTML come from configuration.
export function providerAvatar(provider) {
  const id=String(typeof provider==='string'?provider:provider?.id || 'custom').toLowerCase();
  const canonical=id.replace(/-(?:messages|responses)$/,'');
  const key=Object.hasOwn(aliases,id)?aliases[id]:Object.hasOwn(brands,canonical)?canonical:id,brand=Object.hasOwn(brands,key)?brands[key]:undefined;
  const avatar=document.createElement('span');avatar.className='provider-avatar';avatar.dataset.provider=key;
  avatar.setAttribute('aria-hidden','true');
  if(brand) {
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),use=document.createElementNS(ns,'use');
    svg.setAttribute('viewBox',`0 0 ${brand[1]} ${brand[1]}`);svg.setAttribute('focusable','false');
    use.setAttribute('href',`local-agent://app/provider-logos.svg#${brand[0]}`);svg.append(use);avatar.append(svg);
  } else {
    avatar.classList.add('provider-avatar-fallback');avatar.dataset.provider=id==='demo'?'demo':'custom';
    avatar.dataset.initial=id==='demo'?'⌘':Array.from(id.replace(/[^\p{L}\p{N}]/gu,''))[0]?.toUpperCase() || '·';
  }
  return avatar;
}
