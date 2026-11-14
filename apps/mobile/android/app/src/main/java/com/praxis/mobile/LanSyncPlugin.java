package com.praxis.mobile;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.*;
@CapacitorPlugin(name="LanSync") public class LanSyncPlugin extends Plugin {
  private final java.util.concurrent.ExecutorService executor=java.util.concurrent.Executors.newSingleThreadExecutor();
  private JSONObject decodeConfig(String encoded) throws Exception {
    String[] parts=encoded.split(":");
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
    return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8));
  }
  private String encodeConfig(JSONObject config) throws Exception {
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,key());
    return Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(config.toString().getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
  }
  private String databaseName(JSONObject config) throws Exception {
    if(config==null||!config.has("user"))return "praxis";
    String identity=config.getString("baseUrl")+":"+config.getString("ownerId");
    byte[] hash=java.security.MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
    StringBuilder name=new StringBuilder("praxis_"); for(byte b:hash)name.append(String.format("%02x",b&0xff)); return name.toString();
  }
  private void trust(HttpsURLConnection connection,String caPem) throws Exception {
    if(caPem.isEmpty())return;
    KeyStore trust=KeyStore.getInstance(KeyStore.getDefaultType()); trust.load(null);
    trust.setCertificateEntry("lan",CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(caPem.getBytes(StandardCharsets.UTF_8))));
    TrustManagerFactory factory=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); factory.init(trust);
    SSLContext ssl=SSLContext.getInstance("TLS"); ssl.init(null,factory.getTrustManagers(),null); connection.setSSLSocketFactory(ssl.getSocketFactory());
  }
  private JSONObject response(HttpsURLConnection connection) throws Exception {
    InputStream stream=connection.getResponseCode()<400?connection.getInputStream():connection.getErrorStream();
    ByteArrayOutputStream out=new ByteArrayOutputStream();
    if(stream!=null)try(InputStream in=stream){byte[] buffer=new byte[4096];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>65536)throw new Exception("Response too large");out.write(buffer,0,n);}}
    return out.size()==0?new JSONObject():new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
  }
  @PluginMethod public void accountStatus(PluginCall call){ executor.execute(()->{ try {
    JSONObject c=config(); JSObject result=new JSObject();
    result.put("user",c!=null&&c.has("user")?c.getJSONObject("user"):JSONObject.NULL);
    result.put("baseUrl",c!=null&&c.has("user")?c.getString("baseUrl"):"https://todo.frostraven05.com"); result.put("expiresAt",c!=null?c.opt("expiresAt"):JSONObject.NULL); call.resolve(result);
  } catch(Exception e){call.reject("无法读取账号状态。");} }); }
  @PluginMethod public void accountAuthenticate(PluginCall call){ executor.execute(()->{
    HttpsURLConnection connection=null;
    try {
      String mode=call.getString("mode",""),base=call.getString("baseUrl","").trim(),email=call.getString("email",""),password=call.getString("password",""),name=call.getString("displayName",""),ca=call.getString("caPem","");
      URL url=new URL(base);
      if(!url.getProtocol().equals("https")||url.getHost().isEmpty()||url.getUserInfo()!=null||!(url.getPath().isEmpty()||url.getPath().equals("/"))||url.getQuery()!=null||url.getRef()!=null)throw new Exception("Endpoint");
      if(!mode.equals("login")&&!mode.equals("register"))throw new Exception("Mode");
      if(password.length()<6||password.length()>128||email.length()>254||name.length()>60||ca.length()>65536)throw new Exception("Fields");
      base=base.replaceAll("/+$","");
      SharedPreferences prefs=getContext().getSharedPreferences("lan-secure",Context.MODE_PRIVATE);
      JSONObject previous=config();
      if(ca.isEmpty()&&previous!=null&&base.equals(previous.getString("baseUrl")))ca=previous.optString("caPem","");
      if(ca.isEmpty()&&prefs.contains("config")){JSONObject guest=decodeConfig(prefs.getString("config",null));if(base.equals(guest.getString("baseUrl")))ca=guest.optString("caPem","");}
      String device=prefs.getString("accountDevice",null);
      if(device==null){device=java.util.UUID.randomUUID().toString();if(!prefs.edit().putString("accountDevice",device).commit())throw new Exception("Device storage");}
      JSONObject body=new JSONObject();body.put("email",email.trim());body.put("password",password);body.put("deviceId",device);if(mode.equals("register"))body.put("displayName",name.trim());
      connection=(HttpsURLConnection)new URL(base+"/auth/"+mode).openConnection();trust(connection,ca);
      connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(10000);connection.setReadTimeout(15000);connection.setRequestMethod("POST");connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json");
      try(OutputStream out=connection.getOutputStream()){out.write(body.toString().getBytes(StandardCharsets.UTF_8));} body.remove("password");
      int code=connection.getResponseCode();
      if(code!=200&&code!=201){call.reject(code==401?"邮箱或密码不正确。":code==409?"该邮箱已注册，请登录。":code==429?"尝试次数过多，请稍后重试。":"账号信息无效或服务暂不可用。");return;}
      JSONObject session=response(connection),user=session.getJSONObject("user");
      java.util.UUID.fromString(user.getString("id"));
      if(!device.equals(session.getString("deviceId"))||session.getString("token").length()!=64)throw new Exception("Session");
      JSONObject next=new JSONObject();next.put("baseUrl",base);next.put("ownerId",user.getString("id"));next.put("deviceId",device);next.put("token",session.getString("token"));next.put("caPem",ca);next.put("user",user);next.put("expiresAt",session.getString("expiresAt"));
      if(!prefs.edit().putString("account",encodeConfig(next)).commit())throw new Exception("Account storage"); call.resolve();
    } catch(Exception e){call.reject("无法登录，请检查账号信息、网络、HTTPS 服务地址和证书。");} finally {if(connection!=null)connection.disconnect();}
  }); }
  @PluginMethod public void accountLogout(PluginCall call){ executor.execute(()->{
    HttpsURLConnection connection=null;
    try {
      JSONObject current=config();
      if(current!=null&&current.has("user"))try {
        connection=(HttpsURLConnection)new URL(current.getString("baseUrl")+"/v1/account/logout").openConnection();trust(connection,current.optString("caPem",""));
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(5000);connection.setReadTimeout(5000);connection.setRequestMethod("POST");connection.setRequestProperty("Authorization","Bearer "+current.getString("token"));connection.getResponseCode();
      } catch(Exception ignored){} finally {if(connection!=null)connection.disconnect();}
      if(!getContext().getSharedPreferences("lan-secure",Context.MODE_PRIVATE).edit().remove("account").commit())throw new Exception("Storage");call.resolve();
    }catch(Exception e){call.reject("无法退出账号。");}
  }); }
  private SecretKey key() throws Exception {
    KeyStore ks=KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    if(!ks.containsAlias("praxis-lan")){
      KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
      gen.init(new KeyGenParameterSpec.Builder("praxis-lan",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
      gen.generateKey();
    }
    return (SecretKey)ks.getKey("praxis-lan",null);
  }
  private synchronized JSONObject config() throws Exception {
    SharedPreferences prefs=getContext().getSharedPreferences("lan-secure",Context.MODE_PRIVATE);
    File provision=new File(getContext().getFilesDir(),"lan-provision.json");
    if((getContext().getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0&&provision.exists()){
      String source;
      try (FileInputStream in=new FileInputStream(provision);
      ByteArrayOutputStream out=new ByteArrayOutputStream()){
        byte[] bytes=new byte[8192];
        int n;
        while((n=in.read(bytes))!=-1){
          if(out.size()+n>65536)throw new Exception("Pairing too large");
          out.write(bytes,0,n);
        }
        source=out.toString(StandardCharsets.UTF_8.name());
      }
      JSONObject c=new JSONObject(source);
      URL u=new URL(c.getString("baseUrl"));
      if(!u.getProtocol().equals("https")||u.getUserInfo()!=null||!u.getPath().isEmpty()||u.getQuery()!=null||u.getRef()!=null)throw new Exception("Invalid endpoint");
      for(String field:new String[]{
        "ownerId","deviceId","token","caPem"
      }
      )if(c.getString(field).isEmpty())throw new Exception("Missing pairing field");
      Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE,key());
      String encoded=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(source.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
      if(!prefs.edit().putString("config",encoded).commit())throw new Exception("Pairing storage failed");
      if(!provision.delete())throw new Exception("Pairing cleanup failed");
    }
    String encoded=prefs.getString("account",prefs.getString("config",null));
    if(encoded==null)return null;
    String[] parts=encoded.split(":");
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
    return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8));
  }
  @PluginMethod public void status(PluginCall call){
    executor.execute(()->{
      try{
        JSONObject c=config();
        JSObject result=new JSObject();
        result.put("configured",c!=null);
        result.put("databaseName",databaseName(c));
        if(c!=null)for(String f:new String[]{
          "baseUrl","ownerId","deviceId"
        }
        )result.put(f,c.getString(f));
        call.resolve(result);
      }
      catch(Exception e){
        call.reject("无法读取安全配对配置");
      }
    }
    );
  }
  @PluginMethod public void request(PluginCall call){
    executor.execute(()->{
      HttpsURLConnection connection=null;
      try{
        JSONObject c=config();
        if(c==null)throw new Exception("Unpaired");
        if(!databaseName(c).equals(call.getString("databaseName","praxis")))throw new Exception("Account changed");
        String method=call.getString("method"),path=call.getString("path");
        if(path==null||!(("POST".equals(method)&&(path.matches("/v1/entities/commands\\?generation=[0-9a-fA-F-]{36}")||"/v1/captures/commands".equals(path)))||("GET".equals(method)&&(path.matches("/v1/(captures|entities)/changes\\?after=[0-9]+&limit=25")||path.matches("/v1/entities/snapshot\\?limit=100(&at=[0-9]+&afterId=[0-9a-fA-F-]{36}&generation=[0-9a-fA-F-]{36})?")))))throw new Exception("Forbidden endpoint");
        connection=(HttpsURLConnection)new URL(c.getString("baseUrl")+path).openConnection();
        trust(connection,c.optString("caPem",""));
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Authorization","Bearer "+c.getString("token"));
        if("POST".equals(method)){
          connection.setDoOutput(true);
          connection.setRequestProperty("Content-Type","application/json");
          JSONObject body=new JSONObject(call.getObject("body").toString());
          if(!c.getString("deviceId").equals(body.getString("deviceId")))throw new Exception("Device mismatch");
          byte[] payload=body.toString().getBytes(StandardCharsets.UTF_8);
          if(payload.length>8388608)throw new Exception("Body too large");
          try(OutputStream out=connection.getOutputStream()){
            out.write(payload);
          }
        }
        int status=connection.getResponseCode();
        InputStream stream=status<400?connection.getInputStream():connection.getErrorStream();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        if(stream!=null)try(InputStream in=stream){
          byte[] buffer=new byte[8192];
          int n;
          while((n=in.read(buffer))!=-1){
            if(bytes.size()+n>16777216)throw new Exception("Response too large");
            bytes.write(buffer,0,n);
          }
        }
        JSObject result=new JSObject();
        result.put("status",status);
        result.put("body",new JSObject(bytes.toString(StandardCharsets.UTF_8.name())));
        call.resolve(result);
      }
      catch(Exception e){
        call.reject("局域网连接失败，请检查网络、服务器和证书");
      }
      finally{
        if(connection!=null)connection.disconnect();
      }
    }
    );
  }

  @PluginMethod public void aiRequest(PluginCall call) { executor.execute(()-> {
    HttpsURLConnection connection=null;
    try {
      JSONObject c=config();
      if(c==null||!c.has("user")){call.reject("请先登录账号，再使用 AI 规划。");return;}
      String method=call.getString("method",""),path=call.getString("path","");
      boolean allowed=("GET".equals(method)&&"/v1/ai/status".equals(path))||("POST".equals(method)&&"/v1/ai/runs".equals(path))||
        ("GET".equals(method)&&path.matches("/v1/ai/runs/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))||
        ("POST".equals(method)&&path.matches("/v1/ai/runs/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/cancel"));
      if(!allowed){call.reject("不支持的 AI 请求。");return;}
      connection=(HttpsURLConnection)new URL(c.getString("baseUrl")+path).openConnection();
      trust(connection,c.optString("caPem",""));connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(8000);connection.setReadTimeout(12000);connection.setRequestMethod(method);
      connection.setRequestProperty("Authorization","Bearer "+c.getString("token"));
      if("POST".equals(method)){
        JSObject value=call.getObject("body",new JSObject());byte[] payload=value.toString().getBytes(StandardCharsets.UTF_8);
        if(payload.length>131072)throw new Exception("Too large");
        connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json");
        try(OutputStream out=connection.getOutputStream()){out.write(payload);}
      }
      int status=connection.getResponseCode();InputStream stream=status<400?connection.getInputStream():connection.getErrorStream();
      ByteArrayOutputStream bytes=new ByteArrayOutputStream();
      if(stream!=null)try(InputStream in=stream){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(bytes.size()+n>1048576)throw new Exception("Too large");bytes.write(buffer,0,n);}}
      JSObject result=new JSObject();result.put("status",status);result.put("body",new JSObject(bytes.toString(StandardCharsets.UTF_8.name())));call.resolve(result);
    } catch(Exception e){call.reject("无法确认 AI 请求结果，请检查网络后恢复。");}
    finally{if(connection!=null)connection.disconnect();}
  }); }
}
