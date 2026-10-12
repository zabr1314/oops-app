(() => {
  const descriptions = {
    normal:'打开「会话」→上线方案评审→查看 AI 纪要，随后逐项核对。核对保存后，再看纪要是否提示来源变化。',
    'list-failure':'首页的会话与任务首次读取会失败；点击对应的重新读取，确认能恢复。也可以进入记忆，测试项目读取重试。',
    'review-failure':'进入会话→上线方案评审→会后核对。首次保存会失败；核对项与选择应保留，点击重试后才推进。',
    'minutes-pending':'进入会话→上线方案评审→AI 纪要。此情境保持等待生成，不会把刷新误当重新生成。',
    'minutes-source-changed':'进入会话→上线方案评审→AI 纪要。旧正文应收起，只保留来源变化提示和历史文档入口。',
    'minutes-failure':'进入会话→上线方案评审→AI 纪要。首次读取失败，重试后恢复，不产生新的纪要或外部任务。',
  };
  const select=document.getElementById('flow'), frame=document.getElementById('native-app'), guide=document.getElementById('guide');
  const requested=new URLSearchParams(location.search).get('flow');
  select.value=Object.hasOwn(descriptions,requested) ? requested : 'normal';
  function load(){const flow=select.value;guide.textContent=descriptions[flow];frame.src='./native-preview/index.html?preview=1&flow='+encodeURIComponent(flow);history.replaceState(null,'','?flow='+encodeURIComponent(flow));}
  select.addEventListener('change',load);document.getElementById('restart').addEventListener('click',load);load();
})();
