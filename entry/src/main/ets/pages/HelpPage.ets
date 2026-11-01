import { LexiBackHeader } from '../components/LexiBackHeader';

@Builder
export function helpPageBuilder() {
  HelpPage()
}

@Component
export struct HelpPage {
  @StorageProp('lexiTopInset') titleTopInset: number = 0;
  @StorageProp('lexiBottomInset') bottomInset: number = 0;
  @StorageProp('lexiViewportWidth') viewportWidth: number = 390;
  private pathStack: NavPathStack = new NavPathStack();

  @Builder
  guideSection(title: string, desc: string, bullets: string[]) {
    Column({ space: 10 }) {
      Text(title)
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Text(desc)
        .fontSize(13)
        .lineHeight(21)
        .fontColor($r('app.color.text_secondary'))
      ForEach(
        bullets,
        (line: string) => {
          Row({ space: 8 }) {
            Text('•')
              .fontSize(14)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.brand'))
            Text(line)
              .fontSize(13)
              .lineHeight(20)
              .fontColor($r('app.color.text_primary'))
              .layoutWeight(1)
          }
          .width('100%')
          .alignItems(VerticalAlign.Top)
        },
        (line: string): string => line
      )
    }
    .width('100%')
    .padding(20)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(24)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private pageTitleBar() {
    LexiBackHeader({
      title: '使用说明',
      onBack: () => {
        this.pathStack.pop();
      }
    })
  }

  build() {
    NavDestination() {
      Scroll() {
        Column({ space: 16 }) {
          this.guideSection(
            '快速记录',
            '无需预先填写标题或套用模板，打开首页即可直接输入。',
            [
              '在首页「随手记」输入内容后点击「记下」，选择目标工作区即可保存。',
              '编辑器自动将内容保存为本地标准 Markdown 文件。',
              '标题、#层级标签与所属笔记本可随时补充。'
            ]
          )

          this.guideSection(
            '实时预览编辑',
            '打开笔记即可看到排版，点击某一段落才展开该段 Markdown 源码，其余内容继续保持预览。',
            [
              '普通段落按回车进入下一行后，上一段自动渲染；点击其他段落也会恢复已完成段落的排版。',
              '表格、代码块和公式按完整内容块编辑，避免修改时拆散结构。',
              '点击底部「工具」打开小浮窗，选择格式后自动收起，并在原光标处插入。',
              '大纲、链接、属性及全文源码等入口位于工具浮窗的「面板与视图」中。'
            ]
          )

          this.guideSection(
            '编辑工具分层',
            '同一篇笔记可在「简洁 / 学习 / 专业」三级工具间切换，底层 Markdown 内容完整保留。',
            [
              '简洁：保留标题、清单、粗体与撤销重做，适合日常记录。',
              '学习：提供 ==高亮==、$$LaTeX 公式$$、代码块、折叠提示框与大纲。',
              '专业：提供 [[双向链接]]、源码与预览对照、自定义属性与反向引用。'
            ]
          )

          this.guideSection(
            '思维导图与关联',
            '导图节点与白板卡片均可关联笔记、折叠分支或切换大纲视图。',
            [
              '支持向右、双向、组织三种树形布局，以及导图与大纲视图切换。',
              '导图节点和白板卡片可关联已有笔记，或直接由节点生成新笔记。',
              '笔记重命名时，[[双向链接]] 与导图引用会自动同步。'
            ]
          )

          this.guideSection(
            '1.1.0 每日笔记与模板',
            '首页与桌面侧边栏可一键打开今日笔记，同一天会继续使用已有日记。',
            [
              '模板独立于工作区保存，内置日记、日程、代码、学习、会议和项目模板，均可编辑。右键或手机长按笔记选择“设为模板”，也可在模板库中新建，并设置默认日记模板。',
              '模板支持 {{date}}、{{time}}、{{title}} 与 {{weekday}} 动态变量。',
              '阅读和分栏支持表格、图片、有序列表、分割线、高亮、删除线和代码一键复制。',
              '外部文件夹笔记的属性和标签会与 Markdown 文件头部的 YAML 双向同步。'
            ]
          )

          this.guideSection(
            '桌面服务卡片',
            '通过系统桌面的服务卡片入口添加知萤卡片。卡片显示最近同步的工作区内容。',
            [
              '2×2「灵感速记」可打开文字速记、离线语音面板或今日笔记；打开语音面板后点击录音才会启用麦克风。',
              '2×4「今日与回顾」显示今日笔记的待办和一篇旧笔记，点击即可继续记录或回顾。',
              '直接点选卡片中的待办即可勾选或取消。内容已变化时会提示，只有真实保存成功后才更新勾选状态。',
              '保存笔记后卡片自动同步；也可点击刷新。日期变化后打开今日笔记更新待办。'
            ]
          )

          this.guideSection(
            '系统分享剪藏',
            '在支持系统分享的应用中分享选中文字或网页链接，选择「知萤收件箱」。',
            [
              '保存前可编辑标题、来源和摘录，并选择工作区与项目，预览 Markdown 后再确认。',
              '内容保存到「剪藏收件箱」，保留来源链接与剪藏标签；同一次分享重复点击不会创建重复笔记。',
              '只接收分享面板提供的文字与链接，不会自动下载整篇网页或读取附件。'
            ]
          )

          this.guideSection(
            '跨设备接续',
            '打开普通笔记后，可通过支持此功能的鸿蒙设备系统接续入口，继续编辑当前草稿。',
            [
              '两台真机需安装相同版本，登录相同华为账号，并开启系统接续、蓝牙与 WLAN。模拟器不支持跨设备接续。',
              '接续保留当前标题、正文、属性、编辑模式与光标位置；接收端内容不同时另存草稿副本，保留双方内容。',
              '这是单篇编辑状态接续，不会同步整个工作区。草稿传输大小上限约 90 KB，超出时会提示。'
            ]
          )

          this.guideSection(
            '离线语音与本地整理',
            '手机底部或宽屏编辑器顶部的「工具」中选择「语音 / 整理」，打开后选择需要的功能。',
            [
              '中文离线语音需设备提供相应离线服务与模型。点击「开始录音」才请求麦克风权限，最长 60 秒，可停止或取消；进入后台后停止录音并保留已识别文字。',
              '识别文字可修改，点击「插入」才写入笔记。不支持离线识别的设备仍可手动输入，应用不会切换到联网识别。',
              '「本地整理」摘录摘要和行动项，并匹配已有笔记链接与标签；逐项选择后插入，原正文保留。设备支持时用离线语义模型对比最近 24 篇可用笔记，模型不可用时保留规则建议，不联网下载。',
              '摘要与行动项仍是原文摘录、规则提取，不是生成式 AI。语义相近不代表内容一定相关，插入前请确认。'
            ]
          )

          this.guideSection(
            '快捷键与数据导出',
            '支持键盘快捷操作与完整本地数据导出。',
            [
              '思维导图：选中节点后可快速添加子主题、同级主题或折叠分支。',
              '双向链接：输入 [[ 自动补全笔记，[[笔记# 补全章节；# 补全标签。![[笔记#章节]] 可嵌入内容。',
              '桌面 Ctrl/Cmd+O 快速切换文档，Ctrl/Cmd+P 打开命令面板，Ctrl/Cmd+E 切换编辑与阅读。',
              '搜索支持 tag:#标签、type:study、notebook:分类 等组合条件；关联面板可一键转换未链接提及。',
              '数据导出：支持导出单篇 .md、整库 Markdown、导图 .json 及完整备份包。'
            ]
          )
        }
        .width('100%')
        .constraintSize({ maxWidth: 920 })
        .padding({ left: 20, right: 20, bottom: 36 + this.bottomInset })
      }
      .width('100%')
      .height('100%')
      .contentStartOffset(56 + (this.viewportWidth < 840 ? this.titleTopInset : 0))
      .contentEndOffset(0)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    }
    .hideBackButton(true)
    .title(
      {
        builder: () => {
          this.pageTitleBar();
        },
        height: 56 + (this.viewportWidth < 840 ? this.titleTopInset : 0)
      },
      {
        barStyle: BarStyle.STACK,
        scrollEffectOptions: { scrollEffectType: ScrollEffectType.GRADUAL_BLUR }
      }
    )
    .backgroundColor($r('app.color.background'))
    .onReady((ctx: NavDestinationContext) => {
      this.pathStack = ctx.pathStack;
    })
  }
}
