#include "model/database.h"
#include "model/document.h"
#include "ui/editor_tab.h"
#include "ui/content_edit.h"
#include "io/clipboard.h"
#include <QClipboard>
#include <QMimeData>
#include <QApplication>
#include <QTextDocument>
#include <QTextCursor>
#include <QTextImageFormat>
#include <QBuffer>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QFile>
#include <QTimer>
#include <QTextStream>
#include <QTextBlock>
#include <QJsonArray>
#include <QTextListFormat>
#include <QKeyEvent>
#include <QUrl>
#include <windows.h>
#include <ole2.h>
#include <psapi.h>

int main(int argc,char**argv){
  QApplication app(argc,argv);if(argc<3)return 2;
  const QString mode=QString::fromLocal8Bit(argv[1]),file=QString::fromLocal8Bit(argv[2]);
  if(mode=="copy-files"){
    QFile input(file);if(!input.open(QIODevice::ReadOnly))return 9;const auto request=QJsonDocument::fromJson(input.readAll()).object();
    QList<QUrl> urls;for(const auto value:request.value("files").toArray())urls.append(QUrl::fromLocalFile(value.toString()));
    auto* mime=new QMimeData;mime->setUrls(urls);QApplication::clipboard()->setMimeData(mime);
    QTextStream(stdout)<<QJsonDocument(QJsonObject{{"text",mime->text()},{"formats",QJsonArray::fromStringList(mime->formats())}}).toJson();
    if(QGuiApplication::platformName()=="windows"&&FAILED(OleFlushClipboard()))return 13;return 0;
  }
  if(mode=="copy-rich"||mode=="paste-rich"){
    QFile input(file);if(!input.open(QIODevice::ReadOnly))return 9;const auto request=QJsonDocument::fromJson(input.readAll()).object();
    tl::Document doc;QString error;if(!doc.open(file+".tde",&error))return 3;tl::EditorTab tab(&doc);tl::ContentEdit edit(&tab);edit.loadHtml(request.value("html").toString());
    if(mode=="copy-rich"){
      edit.selectAll();QKeyEvent key(QEvent::KeyPress,Qt::Key_C,Qt::ControlModifier);QApplication::sendEvent(&edit,&key);
      const auto* mime=QApplication::clipboard()->mimeData();QTextStream(stdout)<<QJsonDocument(QJsonObject{{"text",mime->text()},{"html",mime->html()},{"richText",mime->hasFormat("application/x-tde-richtext")}}).toJson();
      // Materialize Qt's delayed OLE formats before this short-lived helper exits.
      // https://learn.microsoft.com/windows/win32/api/ole2/nf-ole2-oleflushclipboard
      if(QGuiApplication::platformName()=="windows"&&FAILED(OleFlushClipboard()))return 13;return 0;
    }
    edit.setPlainText("abcdef");auto cursor=edit.textCursor();cursor.setPosition(2);edit.setTextCursor(cursor);
    auto* mime=new QMimeData;mime->setHtml(request.value("html").toString());if(request.contains("text"))mime->setText(request.value("text").toString());if(request.value("richText").toBool())mime->setData("application/x-tde-richtext","1");QApplication::clipboard()->setMimeData(mime);edit.paste();
    QTextStream(stdout)<<QJsonDocument(QJsonObject{{"text",edit.toPlainText()},{"html",edit.toHtml()}}).toJson();return 0;
  }
  if(mode=="inspect-image"){
    QFile input(file);if(!input.open(QIODevice::ReadOnly))return 9;
    const auto image=QImage::fromData(input.readAll());if(image.isNull())return 10;
    const auto pixel=image.pixelColor(0,0);
    QTextStream(stdout)<<QJsonDocument(QJsonObject{{"width",image.width()},{"height",image.height()},{"pixel",QJsonArray{pixel.red(),pixel.green(),pixel.blue(),pixel.alpha()}}}).toJson();return 0;
  }
  if(mode=="clipboard"){
    if(argc<4)return 8;
    QFile input(file);if(!input.open(QIODevice::ReadOnly))return 9;
    auto* mime=new QMimeData;mime->setData("application/x-tde-events",input.readAll());QApplication::clipboard()->setMimeData(mime);
    auto data=tl::Clipboard::get();if(data.clips.isEmpty())return 10;
    for(auto&clip:data.clips){clip.assets=data.assets;clip.assetSizes=data.assetSizes;}
    tl::Clipboard::put(data.clips);
    QFile output(QString::fromLocal8Bit(argv[3]));if(!output.open(QIODevice::WriteOnly))return 11;
    const auto encoded=QApplication::clipboard()->mimeData()->data("application/x-tde-events");
    if(output.write(encoded)!=encoded.size())return 12;output.close();
    if(QGuiApplication::platformName()=="windows"&&FAILED(OleFlushClipboard()))return 13;return 0;
  }
  if(mode=="benchmark"){
    QElapsedTimer clock;clock.start();tl::Document doc;QString error;if(!doc.open(file,&error)){qCritical()<<error;return 3;}
    tl::EditorTab tab(&doc);tab.resize(1240,840);tab.show();
    QTimer::singleShot(0,[&]{const double first=clock.nsecsElapsed()/1e6;clock.restart();const auto hits=doc.searchIndices(QStringLiteral("事件 4999"));const double search=clock.nsecsElapsed()/1e6;PROCESS_MEMORY_COUNTERS pmc{};GetProcessMemoryInfo(GetCurrentProcess(),&pmc,sizeof(pmc));QJsonObject result{{"firstEditableMs",first},{"searchMs",search},{"hits",hits.size()},{"workingSetMB",double(pmc.WorkingSetSize)/1048576},{"liveWidgets",tab.liveWidgetCount()}};QTextStream(stdout)<<QJsonDocument(result).toJson();app.quit();});return app.exec();
  }
  if(mode=="paste-selection"){
    if(argc<4)return 8;QFile input(QString::fromLocal8Bit(argv[3]));if(!input.open(QIODevice::ReadOnly))return 9;
    const auto request=QJsonDocument::fromJson(input.readAll()).object();tl::Document doc;QString error;if(!doc.open(file,&error))return 3;
    tl::EditorTab tab(&doc);for(const auto value:request.value("selected").toArray())tab.selectEvent(value.toInt(),true);
    auto* mime=new QMimeData;if(request.contains("events"))mime->setData("application/x-tde-events",QJsonDocument(request.value("events").toObject()).toJson());else mime->setText(request.value("text").toString());QApplication::clipboard()->setMimeData(mime);
    tab.pasteFocusedEvent();if(!doc.save())return 4;QJsonArray result;for(int i=0;i<doc.eventCount();i++){const auto e=doc.eventAt(i);result.append(QJsonObject{{"text",e.contentText},{"done",e.done},{"created_at",e.createdAt.toSecsSinceEpoch()}});}QTextStream(stdout)<<QJsonDocument(result).toJson();return 0;
  }
  tl::Database db;QString err;if(!db.open(file,&err)){qCritical()<<err;return 3;}
  if(mode=="create"){
    QImage image(800,600,QImage::Format_ARGB32);image.fill(QColor("#4689c4"));QByteArray bytes;QBuffer buffer(&bytes);buffer.open(QIODevice::WriteOnly);image.save(&buffer,"PNG");const auto id=db.insertAsset(bytes,image.size());
    QTextDocument body;QTextCursor cursor(&body);cursor.insertText(QStringLiteral("旧版创建：中文与 English "));QTextCharFormat format;format.setFontWeight(QFont::Bold);format.setForeground(QColor("#cc5577"));cursor.insertText(QStringLiteral("加粗彩色"),format);cursor.insertBlock();QTextImageFormat img;img.setName(QStringLiteral("asset:%1").arg(id));img.setWidth(240);img.setHeight(180);cursor.insertImage(img);
    tl::EventData e;e.createdAt=QDateTime::fromSecsSinceEpoch(1750000000);e.deadlineRaw=QStringLiteral("明天下午3点");e.deadlineTs=QDateTime::fromSecsSinceEpoch(1750089600);e.topDivider=true;e.done=false;e.pos=1024;e.contentHtml=body.toHtml();e.contentText=body.toPlainText();e.dirty=true;QVector<tl::EventData> events{e};if(!db.saveEvents(events)){qCritical()<<db.lastError();return 4;}
  }else if(mode=="create-image"){
    if(argc<4)return 8;QFile input(QString::fromLocal8Bit(argv[3]));if(!input.open(QIODevice::ReadOnly))return 9;
    const auto bytes=input.readAll();const auto image=QImage::fromData(bytes);if(image.isNull())return 10;
    const auto id=db.insertAsset(bytes,image.size());QTextDocument body;QTextCursor cursor(&body);
    cursor.insertText(QStringLiteral("旧版原图："));QTextImageFormat format;format.setName(QStringLiteral("asset:%1").arg(id));format.setWidth(16);format.setHeight(12);cursor.insertImage(format);
    tl::EventData e;e.createdAt=QDateTime::fromSecsSinceEpoch(1750000000);e.pos=1024;e.topDivider=true;e.contentHtml=body.toHtml();e.contentText=body.toPlainText();e.dirty=true;QVector<tl::EventData> events{e};if(!db.saveEvents(events))return 4;
  }else if(mode=="create-html"){
    if(argc<4)return 8;QFile input(QString::fromLocal8Bit(argv[3]));if(!input.open(QIODevice::ReadOnly))return 9;
    QTextDocument body;body.setHtml(QString::fromUtf8(input.readAll()));
    tl::EventData e;e.createdAt=QDateTime::fromSecsSinceEpoch(1750000000);e.pos=1024;e.topDivider=true;e.contentHtml=body.toHtml();e.contentText=body.toPlainText();e.dirty=true;QVector<tl::EventData> events{e};if(!db.saveEvents(events))return 4;
  }else if(mode=="create-format"){
    QTextDocument body;body.setDefaultFont(QFont(QStringLiteral("Microsoft YaHei"),12));QTextCursor c(&body);
    QTextBlockFormat p;p.setAlignment(Qt::AlignHCenter);p.setLeftMargin(12);p.setRightMargin(24);p.setTopMargin(6);p.setBottomMargin(8);p.setIndent(2);p.setTextIndent(-16);p.setLineHeight(150,QTextBlockFormat::ProportionalHeight);c.setBlockFormat(p);
    QTextCharFormat normal;normal.setFontPointSize(12);c.insertText(QStringLiteral("面积 x"),normal);auto sup=normal;sup.setVerticalAlignment(QTextCharFormat::AlignSuperScript);c.insertText(QStringLiteral("2"),sup);c.insertText(QStringLiteral(" 与 H"),normal);auto sub=normal;sub.setVerticalAlignment(QTextCharFormat::AlignSubScript);c.insertText(QStringLiteral("2"),sub);c.insertText(QStringLiteral("O"),normal);
    QTextBlockFormat right;right.setAlignment(Qt::AlignRight);right.setTextIndent(20);c.insertBlock(right,normal);c.insertText(QStringLiteral("右对齐正文"));
    QTextBlockFormat listed;listed.setLeftMargin(10);listed.setTextIndent(5);c.insertBlock(listed,normal);QTextListFormat list;list.setStyle(QTextListFormat::ListDecimal);list.setIndent(1);c.createList(list);c.insertText(QStringLiteral("列表项"));
    QTextBlockFormat fixed;fixed.setLineHeight(28,QTextBlockFormat::FixedHeight);fixed.setLayoutDirection(Qt::RightToLeft);fixed.setAlignment(Qt::AlignRight);c.insertBlock(fixed,normal);c.insertText(QStringLiteral("עברית"));
    tl::EventData e;e.createdAt=QDateTime::fromSecsSinceEpoch(1750000000);e.pos=1024;e.topDivider=true;e.contentHtml=body.toHtml();e.contentText=body.toPlainText();e.dirty=true;QVector<tl::EventData> events{e};if(!db.saveEvents(events))return 4;
  }else if(mode=="inspect-format"){
    const auto events=db.loadEvents();QJsonArray result;
    for(const auto&e:events){QTextDocument body;body.setHtml(db.eventHtml(e.id));for(auto b=body.begin();b.isValid();b=b.next()){
      const auto f=b.blockFormat();QJsonArray runs;for(auto i=b.begin();!i.atEnd();++i){const auto fragment=i.fragment();if(fragment.isValid())runs.append(QJsonObject{{"text",fragment.text()},{"vertical",fragment.charFormat().verticalAlignment()},{"fontSize",fragment.charFormat().fontPointSize()}});}
      result.append(QJsonObject{{"text",b.text()},{"alignment",int(f.alignment())},{"direction",int(f.layoutDirection())},{"indent",f.indent()},{"textIndent",f.textIndent()},{"left",f.leftMargin()},{"right",f.rightMargin()},{"top",f.topMargin()},{"bottom",f.bottomMargin()},{"lineHeight",f.lineHeight()},{"heightType",f.lineHeightType()},{"runs",runs}});
    }}QTextStream(stdout)<<QJsonDocument(result).toJson();
  }else if(mode=="edit"){
    auto events=db.loadEvents();if(events.isEmpty())return 5;
    for(auto&e:events){QTextDocument body;body.setHtml(db.eventHtml(e.id));QTextCursor cursor(&body);cursor.movePosition(QTextCursor::End);cursor.insertBlock();cursor.insertText(QStringLiteral("旧版再次编辑"));e.contentHtml=body.toHtml();e.contentText=body.toPlainText();e.dirty=true;}
    if(!db.saveEvents(events)){qCritical()<<db.lastError();return 6;}
  }else return 7;
  db.close();return 0;
}
