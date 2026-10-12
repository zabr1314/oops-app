import { useState } from 'react';
import { useOops } from '../store';
import { Badge, Button, Card, Check, Notice, Sheet } from '../ui';
import { PRIVACY_NOTICE_VERSION, confirmPrivacyNotice, privacyNoticeAcceptedAt } from '../privacyNoticeLogic';
import './PrivacyNotice.css';

export function PrivacyNoticeCard({onConfirmed}: {onConfirmed?: () => void}) {
  const {data, update} = useOops();
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const acceptedAt = privacyNoticeAcceptedAt(data);
  const confirm = () => {
    if (!checked) return;
    update(current => confirmPrivacyNotice(current, checked));
    setChecked(false);
    onConfirmed?.();
  };
  return <Card className="privacy-notice-card">
    <div className="privacy-notice-heading"><h3>使用与隐私说明</h3><Badge tone={acceptedAt ? 'green' : 'gray'}>{acceptedAt ? '已确认本版' : '尚未确认'}</Badge></div>
    <p>先了解信息怎样使用，再决定开启哪些能力。</p>
    <Notice>当前网页用于原型体验。此确认不会开启麦克风、上传资料、共享声纹或发送消息。</Notice>
    <Button tone="secondary" icon="shield-check" onClick={() => setOpen(true)}>阅读使用与隐私说明</Button>
    <small>说明版本：{PRIVACY_NOTICE_VERSION}{acceptedAt && <><br/>确认于 {new Intl.DateTimeFormat('zh-CN', {dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Shanghai'}).format(new Date(acceptedAt))}</>}</small>
    <Check label="我已阅读并了解本版使用与隐私说明" value={checked} onChange={setChecked}/>
    <Button disabled={!checked} onClick={confirm}>{onConfirmed ? '确认并继续' : '保存本版确认'}</Button>
    <Sheet open={open} onClose={() => setOpen(false)} title="使用与隐私说明（原型）">
      <div className="privacy-notice-body">
        <p className="meta">版本：{PRIVACY_NOTICE_VERSION}</p>
        <h3>1. 当前体验会留下什么</h3>
        <p>示例会话、你填写的称呼与角色、偏好，以及你在页面里确认的任务和记忆用于演示前端流程。请使用示例内容体验。</p>
        <h3>2. 信息怎样使用</h3>
        <p>页面从当前可见的记录中整理重点、任务和记忆。匿名发言需要由你核对身份；候选内容需要确认，才会作为已确认信息使用。</p>
        <h3>3. 每项授权分别选择</h3>
        <p>云端处理、长期记忆、声音身份、团队共享和外部应用各自设置。确认这份说明不会代替这些授权；姓名核对也不会自动注册或共享声纹。</p>
        <h3>4. 保存、查看与管理</h3>
        <p>普通网页体验在浏览器允许时将前端示例保存在本机；画板预览使用独立示例，不写入普通体验。可在隐私设置中查看记录范围、导出或删除本地内容。真实服务的存储位置和保留规则仍需单独确认。</p>
        <h3>5. 外部操作由你确认</h3>
        <p>生成消息、日程和文档草稿不等于已经发送或创建。本页不办理真实登录、麦克风授权或第三方授权；接入真实服务时，需要展示对应说明并完成单独确认。</p>
        <Button onClick={() => setOpen(false)}>返回确认</Button>
      </div>
    </Sheet>
  </Card>;
}
